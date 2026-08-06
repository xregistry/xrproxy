import express from 'express';
import { EntityStateManager } from '../../shared/entity-state-manager';
import * as modelData from '../model.json';
import { CacheManager } from './cache/cache-manager';
import { CacheService } from './cache/cache-service';
import { CACHE_CONFIG, getBaseUrl, GROUP_CONFIG, HTTP_STATUS, NUGET_REGISTRY, PAGINATION, REGISTRY_CONFIG, RESOURCE_CONFIG } from './config/constants';
import { corsMiddleware } from './middleware/cors';
import { createLoggingMiddleware } from './middleware/logging';
import { parseXRegistryFlags } from './middleware/xregistry-flags';
import { NuGetService } from './services/nuget-service';
import { PackageMetadata, Registry } from './types/xregistry';

class SimpleLogger {
    info(message: string, data?: unknown): void { console.log(`[INFO] ${message}`, data ? JSON.stringify(data, null, 2) : ''); }
    error(message: string, data?: unknown): void { console.error(`[ERROR] ${message}`, data ? JSON.stringify(data, null, 2) : ''); }
    warn(message: string, data?: unknown): void { console.warn(`[WARN] ${message}`, data ? JSON.stringify(data, null, 2) : ''); }
    debug(message: string, data?: unknown): void { console.debug(`[DEBUG] ${message}`, data ? JSON.stringify(data, null, 2) : ''); }
}

function sendProblem(res: express.Response, status: number, title: string, instance: string, detail?: string): void {
    res.status(status).type('application/problem+json').json({ type: 'about:blank', title, status, ...(detail ? { detail } : {}), instance });
}

function isCanonicalPackageId(packageId: string): boolean { return packageId === packageId.toLowerCase(); }

function matchesExpression(entity: Record<string, unknown>, expression: string): boolean {
    const operator = expression.includes('!=') ? '!=' : '=';
    const parts = expression.split(operator).map((part) => part.trim());
    if (parts.length !== 2 || !parts[0]) return false;
    const attribute = parts[0];
    const rawValue = (parts[1] || '').replace(/^['\"]|['\"]$/g, '');
    const entityValue = entity[attribute];
    if (entityValue === undefined) return operator === '!=';
    const values = Array.isArray(entityValue) ? entityValue.map(String) : [String(entityValue)];
    const pattern = rawValue.includes('*') ? new RegExp(`^${rawValue.replace(/[.+?^${}()|[\\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i') : null;
    const matched = values.some((value) => pattern ? pattern.test(value) : value === rawValue);
    return operator === '=' ? matched : !matched;
}

function applyFilters(packages: Record<string, PackageMetadata>, filterGroups: string[][] | undefined): Record<string, PackageMetadata> {
    if (!filterGroups || filterGroups.length === 0) return packages;
    return Object.fromEntries(Object.entries(packages).filter(([, pkg]) => {
        const candidate = pkg as unknown as Record<string, unknown>;
        return filterGroups.some((group) => group.every((expression) => matchesExpression(candidate, expression)));
    }));
}

function applySort(packages: Record<string, PackageMetadata>, sort: { attribute: string; direction: 'asc' | 'desc' } | undefined): Record<string, PackageMetadata> {
    if (!sort) return packages;
    const entries = Object.entries(packages).sort(([, left], [, right]) => {
        const leftValue = left[sort.attribute]; const rightValue = right[sort.attribute];
        if (leftValue === undefined) return 1; if (rightValue === undefined) return -1;
        const comparison = String(leftValue).localeCompare(String(rightValue));
        return sort.direction === 'desc' ? -comparison : comparison;
    });
    return Object.fromEntries(entries);
}

export interface ServerOptions { port?: number; host?: string; nugetRegistryUrl?: string; cacheEnabled?: boolean; cacheTtl?: number; logLevel?: string; }

export class XRegistryServer {
    private readonly app: express.Application;
    private server: unknown;
    private readonly nugetService: NuGetService;
    private readonly cacheService: CacheService;
    private readonly cacheManager: CacheManager;
    private readonly logger: SimpleLogger;
    private readonly options: Required<ServerOptions>;
    private readonly entityState: EntityStateManager;
    private readonly model: unknown;

    constructor(options: ServerOptions = {}) {
        this.options = { port: options.port || 3100, host: options.host || '0.0.0.0', nugetRegistryUrl: options.nugetRegistryUrl || NUGET_REGISTRY.BASE_URL, cacheEnabled: options.cacheEnabled !== false, cacheTtl: options.cacheTtl || CACHE_CONFIG.CACHE_TTL_MS, logLevel: options.logLevel || 'info' };
        this.logger = new SimpleLogger();
        this.app = express();
        this.model = modelData;
        this.entityState = new EntityStateManager();
        this.cacheService = new CacheService({ maxSize: CACHE_CONFIG.MAX_CACHE_SIZE, ttlMs: this.options.cacheTtl, enablePersistence: true, cacheDir: CACHE_CONFIG.CACHE_DIR });
        this.cacheManager = new CacheManager({ baseDir: CACHE_CONFIG.CACHE_DIR, defaultTtl: this.options.cacheTtl });
        this.nugetService = new NuGetService({ searchUrl: NUGET_REGISTRY.SEARCH_URL, registrationBaseUrl: NUGET_REGISTRY.REGISTRATION_BASE_URL, catalogIndexUrl: NUGET_REGISTRY.CATALOG_INDEX_URL, serviceIndexUrl: NUGET_REGISTRY.SERVICE_INDEX_URL, flatContainerUrl: NUGET_REGISTRY.FLAT_CONTAINER_URL, cacheTtl: this.options.cacheTtl, cacheDir: CACHE_CONFIG.CACHE_DIR, entityState: this.entityState, cacheManager: this.cacheManager });
        this.setupMiddleware();
        this.setupRoutes();
        this.setupErrorHandling();
    }

    private setupMiddleware(): void {
        this.app.set('trust proxy', true);
        this.app.use(express.json({ limit: '10mb' }));
        this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));
        this.app.use(corsMiddleware);
        this.app.use(createLoggingMiddleware({ logger: this.logger }));
        this.app.use(parseXRegistryFlags);
    }
    private async buildRegistry(baseUrl: string, inlineGroups: boolean): Promise<Registry> {
        const rootPath = '/';
        const registry: Registry = {
            specversion: REGISTRY_CONFIG.SPEC_VERSION,
            registryid: REGISTRY_CONFIG.ID,
            xid: rootPath,
            self: baseUrl,
            epoch: this.entityState.getEpoch(rootPath),
            createdat: this.entityState.getCreatedAt(rootPath),
            modifiedat: this.entityState.getModifiedAt(rootPath),
            name: 'NuGet Registry Service',
            description: 'xRegistry projection of the NuGet V3 package registry model',
            modelurl: `${baseUrl}/model`,
            capabilitiesurl: `${baseUrl}/capabilities`,
            dotnetregistriesurl: `${baseUrl}/${GROUP_CONFIG.TYPE}`,
            dotnetregistriescount: 1,
        };
        if (inlineGroups) registry.dotnetregistries = { [GROUP_CONFIG.ID]: await this.nugetService.getGroup(baseUrl, false) };
        return registry;
    }

    private buildPaginationLink(baseUrl: string, query: Record<string, unknown>, totalCount: number, limit: number, offset: number): string | null {
        if (offset + limit >= totalCount) return null;
        const nextUrl = new URL(`${baseUrl}/${GROUP_CONFIG.TYPE}/${GROUP_CONFIG.ID}/${RESOURCE_CONFIG.TYPE}`);
        for (const [key, value] of Object.entries(query)) if (value !== undefined) nextUrl.searchParams.set(key, String(value));
        nextUrl.searchParams.set('limit', String(limit));
        nextUrl.searchParams.set('offset', String(offset + limit));
        return `<${nextUrl.toString()}>; rel="next"`;
    }

    private setupRoutes(): void {
        this.app.get('/health', (_req, res) => {
            res.json({ status: 'healthy', timestamp: new Date().toISOString(), version: process.env['npm_package_version'] || '1.0.0', uptime: process.uptime(), cache: { enabled: this.options.cacheEnabled, stats: this.cacheManager.getStats(), volatileStats: this.cacheService.getStats() } });
        });

        this.app.get('/', async (req, res) => {
            try {
                const baseUrl = getBaseUrl(req);
                const inline = req.xregistryFlags?.inline;
                const registry = await this.buildRegistry(baseUrl, !!inline && (inline.includes('*') || inline.includes(GROUP_CONFIG.TYPE)));
                if (inline && (inline.includes('*') || inline.includes('capabilities'))) registry.capabilities = { apis: ['/capabilities', '/model', '/export'], filter: true, sort: true, doc: true, mutable: false, pagination: true };
                if (inline && (inline.includes('*') || inline.includes('model'))) registry.model = this.model as Record<string, unknown>;
                res.set('Content-Type', 'application/json');
                res.set('xRegistry-Version', REGISTRY_CONFIG.SPEC_VERSION);
                res.json(registry);
            } catch (error) { this.logger.error('Failed to retrieve registry information', { error }); sendProblem(res, HTTP_STATUS.INTERNAL_SERVER_ERROR, 'Failed to retrieve registry information', req.originalUrl); }
        });

        this.app.get('/capabilities', (_req, res) => {
            res.json({ apis: ['/capabilities', '/model', '/export'], filter: true, sort: true, doc: true, mutable: false, pagination: true });
        });
        this.app.get('/export', (req, res) => { res.redirect(`${getBaseUrl(req)}/?doc&inline=*,capabilities,model`); });
        this.app.get('/model', (_req, res) => { res.json(this.model); });

        this.app.get(`/${GROUP_CONFIG.TYPE}`, async (req, res) => {
            try {
                const baseUrl = getBaseUrl(req);
                const includePackages = !!req.xregistryFlags?.inline && (req.xregistryFlags.inline.includes('*') || req.xregistryFlags.inline.includes(RESOURCE_CONFIG.TYPE));
                const group = await this.nugetService.getGroup(baseUrl, includePackages, { query: '', offset: 0, limit: PAGINATION.DEFAULT_PAGE_LIMIT });
                res.json({ [GROUP_CONFIG.ID]: group });
            } catch (error) { this.logger.error('Failed to retrieve groups', { error }); sendProblem(res, HTTP_STATUS.INTERNAL_SERVER_ERROR, 'Failed to retrieve groups', req.originalUrl); }
        });

        this.app.get(`/${GROUP_CONFIG.TYPE}/:registryId`, async (req, res) => {
            try {
                if ((req.params['registryId'] || '') !== GROUP_CONFIG.ID) { sendProblem(res, HTTP_STATUS.NOT_FOUND, 'Registry not found', req.originalUrl, 'No xRegistry group with that id.'); return; }
                const baseUrl = getBaseUrl(req);
                const includePackages = !!req.xregistryFlags?.inline && (req.xregistryFlags.inline.includes('*') || req.xregistryFlags.inline.includes(RESOURCE_CONFIG.TYPE));
                res.json(await this.nugetService.getGroup(baseUrl, includePackages, { query: '', offset: 0, limit: PAGINATION.DEFAULT_PAGE_LIMIT }));
            } catch (error) { this.logger.error('Failed to retrieve group', { error }); sendProblem(res, HTTP_STATUS.INTERNAL_SERVER_ERROR, 'Failed to retrieve group', req.originalUrl); }
        });

        this.app.get(`/${GROUP_CONFIG.TYPE}/:registryId/${RESOURCE_CONFIG.TYPE}`, async (req, res) => {
            try {
                if ((req.params['registryId'] || '') !== GROUP_CONFIG.ID) { sendProblem(res, HTTP_STATUS.NOT_FOUND, 'Registry not found', req.originalUrl, 'No xRegistry group with that id.'); return; }
                const baseUrl = getBaseUrl(req);
                const limit = Math.min(parseInt(String(req.query['limit'] || PAGINATION.DEFAULT_PAGE_LIMIT), 10), PAGINATION.MAX_PAGE_LIMIT);
                const offset = Math.max(parseInt(String(req.query['offset'] || 0), 10), 0);
                const searchResults = await this.nugetService.searchPackageResources(baseUrl, { query: '', offset, limit });
                let packages = searchResults.packages;
                packages = applySort(applyFilters(packages, req.xregistryFlags?.filter), req.xregistryFlags?.sort);
                const link = this.buildPaginationLink(baseUrl, req.query as Record<string, unknown>, searchResults.totalCount, limit, offset);
                if (link) res.set('Link', link);
                res.json(packages);
            } catch (error) { this.logger.error('Failed to retrieve packages', { error }); sendProblem(res, HTTP_STATUS.INTERNAL_SERVER_ERROR, 'Failed to retrieve packages', req.originalUrl); }
        });
        this.app.get(`/${GROUP_CONFIG.TYPE}/:registryId/${RESOURCE_CONFIG.TYPE}/:packageId`, async (req, res) => {
            try {
                const packageId = req.params['packageId'] || '';
                if ((req.params['registryId'] || '') !== GROUP_CONFIG.ID) { sendProblem(res, HTTP_STATUS.NOT_FOUND, 'Registry not found', req.originalUrl, 'No xRegistry group with that id.'); return; }
                if (!isCanonicalPackageId(packageId)) { sendProblem(res, HTTP_STATUS.NOT_FOUND, 'Package not found', req.originalUrl, 'Package identifiers are lowercase in this projection.'); return; }
                const baseUrl = getBaseUrl(req);
                const pkg = await this.nugetService.getPackageMetadata(packageId, baseUrl);
                if (!pkg) { sendProblem(res, HTTP_STATUS.NOT_FOUND, 'Package not found', req.originalUrl, 'No package with that id.'); return; }
                const inline = req.xregistryFlags?.inline;
                if (inline && (inline.includes('*') || inline.includes('meta'))) { const meta = await this.nugetService.getPackageMeta(packageId, baseUrl); if (meta) pkg.meta = meta; }
                if (inline && (inline.includes('*') || inline.includes('versions'))) { const versions = await this.nugetService.getPackageVersions(packageId, baseUrl); if (versions) pkg.versions = versions; }
                res.json(pkg);
            } catch (error) { this.logger.error('Failed to retrieve package', { error }); sendProblem(res, HTTP_STATUS.INTERNAL_SERVER_ERROR, 'Failed to retrieve package metadata', req.originalUrl); }
        });

        this.app.get(`/${GROUP_CONFIG.TYPE}/:registryId/${RESOURCE_CONFIG.TYPE}/:packageId/meta`, async (req, res) => {
            try {
                const packageId = req.params['packageId'] || '';
                if ((req.params['registryId'] || '') !== GROUP_CONFIG.ID) { sendProblem(res, HTTP_STATUS.NOT_FOUND, 'Registry not found', req.originalUrl, 'No xRegistry group with that id.'); return; }
                if (!isCanonicalPackageId(packageId)) { sendProblem(res, HTTP_STATUS.NOT_FOUND, 'Package not found', req.originalUrl, 'Package identifiers are lowercase in this projection.'); return; }
                const meta = await this.nugetService.getPackageMeta(packageId, getBaseUrl(req));
                if (!meta) { sendProblem(res, HTTP_STATUS.NOT_FOUND, 'Package not found', req.originalUrl, 'No package with that id.'); return; }
                res.json(meta);
            } catch (error) { this.logger.error('Failed to retrieve package meta', { error }); sendProblem(res, HTTP_STATUS.INTERNAL_SERVER_ERROR, 'Failed to retrieve package metadata', req.originalUrl); }
        });

        this.app.get(`/${GROUP_CONFIG.TYPE}/:registryId/${RESOURCE_CONFIG.TYPE}/:packageId/versions`, async (req, res) => {
            try {
                const packageId = req.params['packageId'] || '';
                if ((req.params['registryId'] || '') !== GROUP_CONFIG.ID) { sendProblem(res, HTTP_STATUS.NOT_FOUND, 'Registry not found', req.originalUrl, 'No xRegistry group with that id.'); return; }
                if (!isCanonicalPackageId(packageId)) { sendProblem(res, HTTP_STATUS.NOT_FOUND, 'Package not found', req.originalUrl, 'Package identifiers are lowercase in this projection.'); return; }
                const versions = await this.nugetService.getPackageVersions(packageId, getBaseUrl(req));
                if (!versions) { sendProblem(res, HTTP_STATUS.NOT_FOUND, 'Package not found', req.originalUrl, 'No package with that id.'); return; }
                res.json(versions);
            } catch (error) { this.logger.error('Failed to retrieve versions', { error }); sendProblem(res, HTTP_STATUS.INTERNAL_SERVER_ERROR, 'Failed to retrieve versions', req.originalUrl); }
        });

        this.app.get(`/${GROUP_CONFIG.TYPE}/:registryId/${RESOURCE_CONFIG.TYPE}/:packageId/versions/:versionId`, async (req, res) => {
            try {
                const packageId = req.params['packageId'] || '';
                const versionId = req.params['versionId'] || '';
                if ((req.params['registryId'] || '') !== GROUP_CONFIG.ID) { sendProblem(res, HTTP_STATUS.NOT_FOUND, 'Registry not found', req.originalUrl, 'No xRegistry group with that id.'); return; }
                if (!isCanonicalPackageId(packageId)) { sendProblem(res, HTTP_STATUS.NOT_FOUND, 'Package not found', req.originalUrl, 'Package identifiers are lowercase in this projection.'); return; }
                if (versionId.includes('+')) { sendProblem(res, HTTP_STATUS.NOT_FOUND, 'Version not found', req.originalUrl, 'Version identifiers replace + with ~ in this projection.'); return; }
                const version = await this.nugetService.getVersionMetadata(packageId, versionId, getBaseUrl(req));
                if (!version) { sendProblem(res, HTTP_STATUS.NOT_FOUND, 'Version not found', req.originalUrl, 'No version with that id.'); return; }
                res.json(version);
            } catch (error) { this.logger.error('Failed to retrieve version', { error }); sendProblem(res, HTTP_STATUS.INTERNAL_SERVER_ERROR, 'Failed to retrieve version metadata', req.originalUrl); }
        });

        this.app.use('*', (req, res) => { sendProblem(res, HTTP_STATUS.NOT_FOUND, 'The specified path is not supported.', req.originalUrl, `No xRegistry route matches ${req.method} ${req.originalUrl}.`); });
    }

    private setupErrorHandling(): void {
        this.app.use((req, res, next) => {
            if (['PUT', 'PATCH', 'POST', 'DELETE'].includes(req.method)) { sendProblem(res, HTTP_STATUS.METHOD_NOT_ALLOWED, 'Method Not Allowed', req.originalUrl, `The ${req.method} method is not allowed for this resource. This registry is read-only.`); return; }
            next();
        });
    }

    public listen(callback?: () => void): void { this.server = this.app.listen(this.options.port, this.options.host, callback); }
    public close(callback?: (err?: Error) => void): void { const closable = this.server as { close?: (cb?: (err?: Error) => void) => void } | undefined; if (closable?.close) { closable.close(callback); return; } callback?.(); }
    public getApp(): express.Application { return this.app; }
}

if (require.main === module) {
    const server = new XRegistryServer({ port: parseInt(process.env['PORT'] || '3100', 10), host: process.env['HOST'] || '0.0.0.0' });
    server.listen(() => { console.log(`NuGet xRegistry wrapper listening on ${process.env['HOST'] || '0.0.0.0'}:${process.env['PORT'] || '3100'}`); });
}
