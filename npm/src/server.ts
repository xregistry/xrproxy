/**
 * xRegistry npm wrapper server.
 */

import express from 'express';
import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import path from 'path';
import { EntityStateManager } from '../../shared/entity-state-manager';
import * as modelData from '../model.json';
import { CacheManager } from './cache/cache-manager';
import { CacheService } from './cache/cache-service';
import { CACHE_CONFIG, getBaseUrl, GROUP_CONFIG, NPM_REGISTRY, PAGINATION } from './config/constants';
import { corsMiddleware } from './middleware/cors';
import { errorHandler } from './middleware/error-handler';
import { createLoggingMiddleware } from './middleware/logging';
import { parseXRegistryFlags } from './middleware/xregistry-flags';
import { xregistryErrorHandler } from './middleware/xregistry-error-handler';
import { NpmService } from './services/npm-service';
import { findVersionById, getNodescopeId, matchesPackageIdentity, normalizePackageId, normalizeVersionId } from './utils/package-utils';

class SimpleLogger {
    info(message: string, data?: any) {
        console.log(`[INFO] ${message}`, data ? JSON.stringify(data, null, 2) : '');
    }
    error(message: string, data?: any) {
        console.error(`[ERROR] ${message}`, data ? JSON.stringify(data, null, 2) : '');
    }
    warn(message: string, data?: any) {
        console.warn(`[WARN] ${message}`, data ? JSON.stringify(data, null, 2) : '');
    }
    debug(message: string, data?: any) {
        console.debug(`[DEBUG] ${message}`, data ? JSON.stringify(data, null, 2) : '');
    }
}

function createProblemDetails(status: number, title: string, detail?: string, instance?: string) {
    return {
        type: 'about:blank',
        title,
        status,
        ...(detail && { detail }),
        ...(instance && { instance }),
    };
}

export interface ServerOptions {
    port?: number;
    host?: string;
    npmRegistryUrl?: string;
    cacheEnabled?: boolean;
    cacheTtl?: number;
    logLevel?: string;
    indexCacheDir?: string;
}

interface ScopeIndexEntry {
    id: string;
    ranges: Array<{ start: number; end: number }>;
}

interface ScopeIndexSnapshot {
    packageCount: number;
    firstPackageName: string;
    lastPackageName: string;
    scopes: ScopeIndexEntry[];
}

export class XRegistryServer {
    private app: express.Application;
    private server: any;
    private npmService!: NpmService;
    // @ts-ignore - reserved for future use
    private cacheService!: CacheService;
    private cacheManager!: CacheManager;
    private logger!: SimpleLogger;
    private entityState: EntityStateManager;
    private options: Required<ServerOptions>;
    private packageNamesCache: string[] = [];
    private scopeCounts = new Map<string, number>([[GROUP_CONFIG.UNSCOPED_ID, 0]]);
    private scopeIds: string[] = [GROUP_CONFIG.UNSCOPED_ID];
    private scopeRanges = new Map<string, Array<{ start: number; end: number }>>();
    private packageNameByIdentity = new Map<string, string>();
    private cacheLoadingPromise: Promise<void> | null = null;
    private model: any;

    constructor(options: ServerOptions = {}) {
        this.options = {
            port: options.port || 3100,
            host: options.host || '0.0.0.0',
            npmRegistryUrl: options.npmRegistryUrl || NPM_REGISTRY.BASE_URL,
            cacheEnabled: options.cacheEnabled !== false,
            cacheTtl: options.cacheTtl || CACHE_CONFIG.CACHE_TTL_MS,
            logLevel: options.logLevel || 'info',
            indexCacheDir: options.indexCacheDir || CACHE_CONFIG.CACHE_DIR,
        };

        this.logger = new SimpleLogger();
        this.entityState = new EntityStateManager();
        this.app = express();
        this.model = modelData;
        this.initializeServices();
        this.setupMiddleware();
        this.setupRoutes();
        this.setupErrorHandling();
    }

    private initializeServices(): void {
        this.cacheService = new CacheService({
            maxSize: CACHE_CONFIG.MAX_CACHE_SIZE,
            ttlMs: this.options.cacheTtl,
            enablePersistence: true,
            cacheDir: CACHE_CONFIG.CACHE_DIR,
        });

        this.cacheManager = new CacheManager({
            baseDir: CACHE_CONFIG.CACHE_DIR,
            defaultTtl: this.options.cacheTtl,
        });

        if (this.options.cacheEnabled) {
            this.npmService = new NpmService({
                registryUrl: this.options.npmRegistryUrl,
                cacheManager: this.cacheManager,
                cacheTtl: this.options.cacheTtl,
            });
        } else {
            this.npmService = new NpmService({
                registryUrl: this.options.npmRegistryUrl,
                cacheTtl: this.options.cacheTtl,
            });
        }

        this.cacheLoadingPromise = this.loadPackageNamesCache();
    }

    private setupMiddleware(): void {
        this.app.set('trust proxy', true);
        this.app.use(express.json({ limit: '10mb' }));
        this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));
        this.app.use(corsMiddleware);
        this.app.use(createLoggingMiddleware({ logger: this.logger }));
        this.app.use(parseXRegistryFlags);
        this.app.use((_req, res, next) => {
            const originalWriteHead = res.writeHead;
            res.writeHead = function (this: typeof res, statusCode: number, ...rest: any[]) {
                const contentType = this.getHeader('Content-Type');
                if (contentType && contentType.toString().startsWith('application/json')) {
                    this.setHeader('Content-Type', 'application/json; schema=https://xregistry.io/schemas/xregistry-v1.0-rc2.json');
                }
                return originalWriteHead.call(this, statusCode, ...rest);
            };
            next();
        });
    }

    private setupRoutes(): void {
        this.app.get('/health', (_req, res) => {
            res.json({
                status: 'healthy',
                timestamp: new Date().toISOString(),
                version: process.env['npm_package_version'] || '1.0.0',
                uptime: process.uptime(),
                cache: {
                    enabled: this.options.cacheEnabled,
                    stats: this.cacheManager.getStats(),
                    packageNames: this.packageNamesCache.length,
                },
            });
        });

        this.app.get('/', async (req, res) => {
            await this.cacheLoadingPromise;
            const baseUrl = getBaseUrl(req);
            const inline = (req as any).xregistryFlags?.inline || [];
            const scopeCounts = this.buildScopeCounts();
            const registryInfo: any = {
                specversion: '1.0-rc2',
                registryid: 'npm-wrapper',
                xid: '/',
                self: baseUrl,
                name: 'NPM Registry Service',
                description: 'xRegistry-compliant npm package registry',
                documentation: 'https://docs.npmjs.com/',
                epoch: this.entityState.getEpoch('/'),
                createdat: this.entityState.getCreatedAt('/'),
                modifiedat: this.entityState.getModifiedAt('/'),
                modelurl: `${baseUrl}/model`,
                capabilitiesurl: `${baseUrl}/capabilities`,
                nodescopesurl: `${baseUrl}/${GROUP_CONFIG.TYPE}`,
                nodescopescount: scopeCounts.size,
            };

            if (inline.includes('*') || inline.includes('model')) {
                registryInfo.model = this.model;
            }
            if (inline.includes('*') || inline.includes('capabilities')) {
                registryInfo.capabilities = this.getCapabilities();
            }
            if (inline.includes('*') || inline.includes(GROUP_CONFIG.TYPE)) {
                const { limit, offset } = this.getPagination(req);
                registryInfo[GROUP_CONFIG.TYPE] = this.buildNodescopeCollection(baseUrl, this.scopeIds.slice(offset, offset + limit), scopeCounts);
                this.setCollectionHeaders(req, res, `/${GROUP_CONFIG.TYPE}`, offset, scopeCounts.size, limit);
            }

            res.set('Content-Type', 'application/json');
            res.set('xRegistry-Version', '1.0-rc2');
            res.json(registryInfo);
        });

        this.app.get('/capabilities', (_req, res) => {
            res.json(this.getCapabilities());
        });

        this.app.get('/export', (_req, res) => {
            res.redirect('/?doc&inline=*,capabilities,model');
        });

        this.app.get('/model', (_req, res) => {
            res.json(this.model);
        });

        this.app.get('/performance/stats', (_req, res) => {
            res.json({
                packageCache: {
                    size: this.packageNamesCache.length,
                },
            });
        });

        this.app.get('/nodescopes', async (req, res) => {
            await this.cacheLoadingPromise;
            const baseUrl = getBaseUrl(req);
            const counts = this.buildScopeCounts();
            const { limit, offset } = this.getPagination(req);
            const filter = req.query['filter'] as string | undefined;
            const sort = req.query['sort'] as string | undefined;
            let scopeIds = filter
                ? this.scopeIds.filter((scopeId) => this.matchesNodescopeFilter(scopeId, filter))
                : this.scopeIds;
            if (sort?.toLowerCase().endsWith('=desc')) {
                scopeIds = [...scopeIds].reverse();
            }
            const totalCount = scopeIds.length;
            this.setCollectionHeaders(req, res, `/${GROUP_CONFIG.TYPE}`, offset, totalCount, limit);
            res.json(this.buildNodescopeCollection(baseUrl, scopeIds.slice(offset, offset + limit), counts));
        });

        this.app.get('/nodescopes/:nodescopeId', async (req, res) => {
            await this.cacheLoadingPromise;
            const nodescopeId = req.params['nodescopeId'] || '';
            const scopeCounts = this.buildScopeCounts();
            if (!scopeCounts.has(nodescopeId)) {
                res.status(404).json(createProblemDetails(404, 'Group not found', `Scope '${nodescopeId}' does not exist`, req.originalUrl));
                return;
            }

            const groupPath = `/nodescopes/${nodescopeId}`;
            res.json(this.buildGroupEntity(getBaseUrl(req), groupPath, nodescopeId, scopeCounts.get(nodescopeId) || 0));
        });

        this.app.get('/nodescopes/:nodescopeId/packages', async (req, res) => {
            await this.cacheLoadingPromise;
            const nodescopeId = req.params['nodescopeId'] || '';
            const scopeCounts = this.buildScopeCounts();
            if (!scopeCounts.has(nodescopeId)) {
                res.status(404).json(createProblemDetails(404, 'Group not found', `Scope '${nodescopeId}' does not exist`, req.originalUrl));
                return;
            }

            const baseUrl = getBaseUrl(req);
            const limit = Math.min(Math.max(parseInt(req.query['limit'] as string || `${PAGINATION.DEFAULT_PAGE_LIMIT}`, 10), 1), PAGINATION.MAX_PAGE_LIMIT);
            const offset = Math.max(parseInt(req.query['offset'] as string || '0', 10), 0);
            const filter = req.query['filter'] as string | undefined;
            const sort = req.query['sort'] as string | undefined;

            const ranges = this.scopeRanges.get(nodescopeId) ?? [];
            let totalCount: number;
            let page: string[];
            if (!filter && !sort) {
                totalCount = this.countScopeRangeEntries(ranges);
                page = this.sliceScopeNames(ranges, offset, limit);
            } else {
                let packageNames = ranges.flatMap((range) => this.packageNamesCache.slice(range.start, range.end));
                if (filter) {
                    packageNames = packageNames.filter((packageName) => this.matchesPackageFilter(packageName, nodescopeId, filter));
                }
                if (sort) {
                    packageNames = this.sortPackageNames(packageNames, sort);
                }
                totalCount = packageNames.length;
                page = packageNames.slice(offset, offset + limit);
            }
            const packages: Record<string, any> = {};

            page.forEach((packageName) => {
                const packageId = normalizePackageId(packageName);
                const packagePath = `/nodescopes/${nodescopeId}/packages/${packageId}`;
                packages[packageId] = {
                    name: packageName,
                    packageid: packageId,
                    xid: packagePath,
                    self: `${baseUrl}${packagePath}`,
                    epoch: this.entityState.getEpoch(packagePath),
                    createdat: this.entityState.getCreatedAt(packagePath),
                    modifiedat: this.entityState.getModifiedAt(packagePath),
                };
            });

            this.setCollectionHeaders(req, res, `/nodescopes/${nodescopeId}/packages`, offset, totalCount, limit);
            res.json(packages);
        });

        this.app.get('/nodescopes/:nodescopeId/packages/:packageId', async (req, res) => {
            await this.cacheLoadingPromise;
            const nodescopeId = req.params['nodescopeId'] || '';
            const packageId = req.params['packageId'] || '';
            const canonicalName = await this.resolvePackageName(nodescopeId, packageId);
            if (!canonicalName) {
                res.status(404).json(createProblemDetails(404, 'Package not found', `Package '${packageId}' does not exist in scope '${nodescopeId}'`, req.originalUrl));
                return;
            }

            const metadata = await this.npmService.getPackageMetadata(canonicalName);
            if (!metadata) {
                res.status(404).json(createProblemDetails(404, 'Package not found', `Package '${canonicalName}' does not exist in registry`, req.originalUrl));
                return;
            }

            const baseUrl = getBaseUrl(req);
            const packagePath = `/nodescopes/${nodescopeId}/packages/${packageId}`;
            res.json({
                ...metadata,
                xid: packagePath,
                self: `${baseUrl}${packagePath}`,
                packageid: packageId,
                versionsurl: `${baseUrl}${packagePath}/versions`,
                versionscount: Object.keys(metadata.versions || {}).length,
                metaurl: `${baseUrl}${packagePath}/meta`,
            });
        });

        this.app.get('/nodescopes/:nodescopeId/packages/:packageId/meta', async (req, res) => {
            await this.cacheLoadingPromise;
            const nodescopeId = req.params['nodescopeId'] || '';
            const packageId = req.params['packageId'] || '';
            const canonicalName = await this.resolvePackageName(nodescopeId, packageId);
            if (!canonicalName) {
                res.status(404).json(createProblemDetails(404, 'Package not found', `Package '${packageId}' does not exist in scope '${nodescopeId}'`, req.originalUrl));
                return;
            }

            const metadata = await this.npmService.getPackageMetadata(canonicalName);
            if (!metadata) {
                res.status(404).json(createProblemDetails(404, 'Package not found', `Package '${canonicalName}' does not exist in registry`, req.originalUrl));
                return;
            }

            const baseUrl = getBaseUrl(req);
            const packagePath = `/nodescopes/${nodescopeId}/packages/${packageId}`;
            const defaultVersion = metadata.versionid;
            res.json({
                xid: `${packagePath}/meta`,
                self: `${baseUrl}${packagePath}/meta`,
                readonly: true,
                compatibility: 'strict',
                epoch: this.entityState.getEpoch(`${packagePath}/meta`),
                createdat: metadata.createdat,
                modifiedat: metadata.modifiedat,
                ...(defaultVersion ? { defaultversionid: defaultVersion, defaultversionurl: `${baseUrl}${packagePath}/versions/${defaultVersion}` } : {}),
                defaultversionsticky: false,
            });
        });

        this.app.get('/nodescopes/:nodescopeId/packages/:packageId/versions/:versionId', async (req, res) => {
            await this.cacheLoadingPromise;
            const nodescopeId = req.params['nodescopeId'] || '';
            const packageId = req.params['packageId'] || '';
            const versionId = req.params['versionId'] || '';
            const canonicalName = await this.resolvePackageName(nodescopeId, packageId);
            if (!canonicalName) {
                res.status(404).json(createProblemDetails(404, 'Package not found', `Package '${packageId}' does not exist in scope '${nodescopeId}'`, req.originalUrl));
                return;
            }

            const packageMetadata = await this.npmService.getPackageMetadata(canonicalName);
            const upstreamVersion = packageMetadata ? findVersionById(versionId, Object.keys(packageMetadata.versions || {})) : null;
            if (!packageMetadata || !upstreamVersion) {
                res.status(404).json(createProblemDetails(404, 'Version not found', `Version '${versionId}' does not exist for package '${canonicalName}'`, req.originalUrl));
                return;
            }

            const versionData = await this.npmService.getVersionMetadata(canonicalName, upstreamVersion);
            if (!versionData) {
                res.status(404).json(createProblemDetails(404, 'Version not found', `Version '${versionId}' does not exist for package '${canonicalName}'`, req.originalUrl));
                return;
            }

            const baseUrl = getBaseUrl(req);
            const versionPath = `/nodescopes/${nodescopeId}/packages/${packageId}/versions/${versionId}`;
            res.json({
                ...versionData,
                xid: versionPath,
                self: `${baseUrl}${versionPath}`,
                packageid: packageId,
                isdefault: packageMetadata.versionid === versionId,
            });
        });

        this.app.get('/nodescopes/:nodescopeId/packages/:packageId/versions', async (req, res) => {
            await this.cacheLoadingPromise;
            const nodescopeId = req.params['nodescopeId'] || '';
            const packageId = req.params['packageId'] || '';
            const canonicalName = await this.resolvePackageName(nodescopeId, packageId);
            if (!canonicalName) {
                res.status(404).json(createProblemDetails(404, 'Package not found', `Package '${packageId}' does not exist in scope '${nodescopeId}'`, req.originalUrl));
                return;
            }

            const metadata = await this.npmService.getPackageMetadata(canonicalName);
            if (!metadata) {
                res.status(404).json(createProblemDetails(404, 'Package not found', `Package '${canonicalName}' does not exist in registry`, req.originalUrl));
                return;
            }

            const baseUrl = getBaseUrl(req);
            const sort = (req.query['sort'] as string | undefined) || 'versionid=asc';
            const sortDirection = sort.toLowerCase().endsWith('=desc') ? 'desc' : 'asc';
            const versionKeys = Object.keys(metadata.versions || {}).sort((left, right) => {
                const comparison = left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
                return sortDirection === 'desc' ? -comparison : comparison;
            });

            const versions: Record<string, any> = {};
            versionKeys.forEach((version) => {
                const normalizedVersion = normalizeVersionId(version);
                versions[normalizedVersion] = {
                    versionid: normalizedVersion,
                    version,
                    packageid: packageId,
                    xid: `/nodescopes/${nodescopeId}/packages/${packageId}/versions/${normalizedVersion}`,
                    self: `${baseUrl}/nodescopes/${nodescopeId}/packages/${packageId}/versions/${normalizedVersion}`,
                    epoch: 1,
                    createdat: metadata.time?.[version] || metadata.createdat,
                    modifiedat: metadata.time?.[version] || metadata.createdat,
                    ancestor: normalizedVersion,
                    isdefault: metadata.versionid === normalizedVersion,
                };
            });

            res.json(versions);
        });

        this.app.all(/.*/, (req, res, next) => {
            const method = req.method.toUpperCase();
            if (['PUT', 'PATCH', 'POST', 'DELETE'].includes(method)) {
                res.status(405).json(createProblemDetails(
                    405,
                    'Method Not Allowed',
                    `This registry is read-only. ${method} operations are not supported.`,
                    req.originalUrl,
                ));
                return;
            }
            next();
        });

        this.app.use(/.*/, (req, res) => {
            res.status(404).json(createProblemDetails(404, 'Not Found', `Route ${req.method} ${req.originalUrl} not found`, req.originalUrl));
        });
    }

    private getCapabilities() {
        return {
            apis: ['/capabilities', '/model', '/export'],
            flags: ['doc', 'epoch', 'filter', 'inline', 'sort', 'specversion'],
            formats: ['xRegistry-json/1.0-rc2'],
            mutable: [],
            pagination: true,
            specversions: ['1.0-rc2'],
        };
    }

    private buildScopeCounts(): Map<string, number> {
        return this.scopeCounts;
    }

    private buildNodescopeCollection(baseUrl: string, scopeIds: string[], counts: Map<string, number>) {
        const collection: Record<string, any> = {};
        scopeIds.forEach((nodescopeId) => {
            const groupPath = `/nodescopes/${nodescopeId}`;
            collection[nodescopeId] = this.buildGroupEntity(baseUrl, groupPath, nodescopeId, counts.get(nodescopeId) || 0);
        });
        return collection;
    }

    private countScopeRangeEntries(ranges: Array<{ start: number; end: number }>): number {
        return ranges.reduce((total, range) => total + range.end - range.start, 0);
    }

    private sliceScopeNames(ranges: Array<{ start: number; end: number }>, offset: number, limit: number): string[] {
        const names: string[] = [];
        let remainingOffset = offset;
        for (const range of ranges) {
            const rangeLength = range.end - range.start;
            if (remainingOffset >= rangeLength) {
                remainingOffset -= rangeLength;
                continue;
            }
            const start = range.start + remainingOffset;
            const take = Math.min(limit - names.length, range.end - start);
            names.push(...this.packageNamesCache.slice(start, start + take));
            remainingOffset = 0;
            if (names.length === limit) break;
        }
        return names;
    }

    private getPagination(req: express.Request): { limit: number; offset: number } {
        const parsedLimit = Number.parseInt(String(req.query['limit'] ?? PAGINATION.DEFAULT_PAGE_LIMIT), 10);
        const parsedOffset = Number.parseInt(String(req.query['offset'] ?? 0), 10);
        return {
            limit: Number.isFinite(parsedLimit)
                ? Math.min(Math.max(parsedLimit, 1), PAGINATION.MAX_PAGE_LIMIT)
                : PAGINATION.DEFAULT_PAGE_LIMIT,
            offset: Number.isFinite(parsedOffset) ? Math.max(parsedOffset, 0) : 0,
        };
    }

    private setCollectionHeaders(
        req: express.Request,
        res: express.Response,
        collectionPath: string,
        offset: number,
        totalCount: number,
        limit: number,
    ): void {
        res.set('X-Total-Count', String(totalCount));
        const links = this.buildPaginationLinks(req, collectionPath, offset, totalCount, limit);
        if (links.length > 0) {
            res.set('Link', links.join(', '));
        }
    }

    private buildPaginationLinks(
        req: express.Request,
        collectionPath: string,
        offset: number,
        totalCount: number,
        limit: number,
    ): string[] {
        if (totalCount === 0) return [];
        const baseUrl = getBaseUrl(req);
        const makeUrl = (targetOffset: number): string => {
            const params = new URLSearchParams();
            for (const [key, value] of Object.entries(req.query)) {
                if (key === 'offset' || key === 'limit') continue;
                if (Array.isArray(value)) {
                    for (const item of value) {
                        if (typeof item === 'string') params.append(key, item);
                    }
                } else if (typeof value === 'string') {
                    params.set(key, value);
                }
            }
            params.set('limit', String(limit));
            params.set('offset', String(targetOffset));
            return `${baseUrl}${collectionPath}?${params.toString()}`;
        };
        const links: string[] = [];
        if (offset > 0) {
            links.push(`<${makeUrl(0)}>; rel="first"`);
            links.push(`<${makeUrl(Math.max(0, offset - limit))}>; rel="prev"`);
        }
        if (offset + limit < totalCount) {
            links.push(`<${makeUrl(offset + limit)}>; rel="next"`);
            links.push(`<${makeUrl(Math.floor((totalCount - 1) / limit) * limit)}>; rel="last"`);
        }
        return links;
    }

    private buildGroupEntity(baseUrl: string, groupPath: string, nodescopeId: string, packageCount: number) {
        return {
            nodescopeid: nodescopeId,
            name: nodescopeId === GROUP_CONFIG.UNSCOPED_ID ? 'unscoped packages' : `@${nodescopeId}`,
            xid: groupPath,
            self: `${baseUrl}${groupPath}`,
            epoch: this.entityState.getEpoch(groupPath),
            createdat: this.entityState.getCreatedAt(groupPath),
            modifiedat: this.entityState.getModifiedAt(groupPath),
            ...(nodescopeId !== GROUP_CONFIG.UNSCOPED_ID ? { scope: nodescopeId } : {}),
            sourceurl: NPM_REGISTRY.BASE_URL,
            packagesurl: `${baseUrl}${groupPath}/packages`,
            packagescount: packageCount,
        };
    }

    private matchesPackageFilter(packageName: string, nodescopeId: string, filter: string): boolean {
        const packageId = normalizePackageId(packageName);
        const expressions = filter.split(',').map((entry) => entry.trim()).filter(Boolean);
        if (expressions.length === 0) {
            return true;
        }

        return expressions.every((expression) => {
            const operator = expression.includes('!=') ? '!=' : '=';
            const [attribute, rawValue] = expression.split(operator);
            const value = (rawValue || '').replace(/^['"]|['"]$/g, '');
            const actual = attribute === 'name'
                ? packageName
                : attribute === 'packageid'
                    ? packageId
                    : attribute === 'nodescopeid'
                        ? nodescopeId
                        : '';

            if (value.includes('*')) {
                const regex = new RegExp(`^${value.replace(/\*/g, '.*')}$`, 'i');
                return operator === '=' ? regex.test(actual) : !regex.test(actual);
            }

            return operator === '=' ? actual === value : actual !== value;
        });
    }

    private matchesNodescopeFilter(nodescopeId: string, filter: string): boolean {
        const expressions = filter.split(',').map((entry) => entry.trim()).filter(Boolean);
        const name = nodescopeId === GROUP_CONFIG.UNSCOPED_ID ? 'unscoped packages' : `@${nodescopeId}`;
        return expressions.length === 0 || expressions.every((expression) => {
            const operator = expression.includes('!=') ? '!=' : '=';
            const [attribute, rawValue] = expression.split(operator);
            const value = (rawValue || '').replace(/^['"]|['"]$/g, '');
            const actual = attribute === 'name'
                ? name
                : attribute === 'nodescopeid' || attribute === 'scope'
                    ? nodescopeId
                    : '';
            const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*');
            const matches = value.includes('*')
                ? new RegExp(`^${escaped}$`, 'i').test(actual)
                : actual.toLowerCase() === value.toLowerCase();
            return operator === '=' ? matches : !matches;
        });
    }

    private sortPackageNames(packageNames: string[], sort?: string): string[] {
        if (!sort) {
            return [...packageNames].sort((left, right) => left.localeCompare(right));
        }

        const [attribute, directionValue] = sort.split('=');
        const direction = (directionValue || 'asc').toLowerCase() === 'desc' ? 'desc' : 'asc';
        return [...packageNames].sort((left, right) => {
            const leftValue = attribute === 'packageid' ? normalizePackageId(left) : left;
            const rightValue = attribute === 'packageid' ? normalizePackageId(right) : right;
            const comparison = leftValue.localeCompare(rightValue, undefined, { numeric: true, sensitivity: 'base' });
            return direction === 'desc' ? -comparison : comparison;
        });
    }

    private async loadPackageNamesCache(): Promise<void> {
        try {
            const names = require('all-the-package-names') as string[];
            this.packageNamesCache = Array.isArray(names) ? names.sort((left, right) => left.localeCompare(right)) : [];
            const restored = await this.restoreScopeIndexSnapshot();
            if (!restored) {
                this.rebuildPackageIdentityIndex();
                await this.persistScopeIndexSnapshot();
            } else {
                this.rebuildHashedPackageIdentityIndex();
            }
            this.logger.info('Package names cache loaded', { count: this.packageNamesCache.length });
        } catch (error: any) {
            this.logger.warn('Failed to load all-the-package-names', { error: error.message });
            this.packageNamesCache = [];
            this.rebuildPackageIdentityIndex();
        }
    }

    private async resolvePackageName(nodescopeId: string, packageId: string): Promise<string | null> {
        const cached = this.packageNameByIdentity.get(`${nodescopeId}\u0000${packageId}`);
        if (cached) return cached;

        const fallback = nodescopeId === GROUP_CONFIG.UNSCOPED_ID ? packageId : `@${nodescopeId}/${packageId}`;
        return matchesPackageIdentity(fallback, nodescopeId, packageId) ? fallback : null;
    }

    private rebuildPackageIdentityIndex(): void {
        const counts = new Map<string, number>([[GROUP_CONFIG.UNSCOPED_ID, 0]]);
        const namesByIdentity = new Map<string, string>();
        const ranges = new Map<string, Array<{ start: number; end: number }>>();

        for (let index = 0; index < this.packageNamesCache.length; index += 1) {
            const packageName = this.packageNamesCache[index]!;
            const nodescopeId = getNodescopeId(packageName);
            const packageId = normalizePackageId(packageName);
            counts.set(nodescopeId, (counts.get(nodescopeId) || 0) + 1);
            if (packageId.startsWith('xh~')) {
                namesByIdentity.set(`${nodescopeId}\u0000${packageId}`, packageName);
            }
            const scopeRanges = ranges.get(nodescopeId);
            const lastRange = scopeRanges?.[scopeRanges.length - 1];
            if (lastRange?.end === index) {
                lastRange.end = index + 1;
            } else {
                const nextRanges = scopeRanges ?? [];
                nextRanges.push({ start: index, end: index + 1 });
                ranges.set(nodescopeId, nextRanges);
            }
        }

        this.scopeCounts = counts;
        this.scopeIds = Array.from(counts.keys()).sort((left, right) => left.localeCompare(right));
        this.scopeRanges = ranges;
        this.packageNameByIdentity = namesByIdentity;
    }

    private rebuildHashedPackageIdentityIndex(): void {
        const namesByIdentity = new Map<string, string>();
        for (const packageName of this.packageNamesCache) {
            const packageId = normalizePackageId(packageName);
            if (packageId.startsWith('xh~')) {
                namesByIdentity.set(`${getNodescopeId(packageName)}\u0000${packageId}`, packageName);
            }
        }
        this.packageNameByIdentity = namesByIdentity;
    }

    private async restoreScopeIndexSnapshot(): Promise<boolean> {
        try {
            const snapshotPath = path.join(this.options.indexCacheDir, 'npm-scope-index.json');
            const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8')) as ScopeIndexSnapshot;
            if (
                snapshot.packageCount !== this.packageNamesCache.length
                || snapshot.firstPackageName !== (this.packageNamesCache[0] ?? '')
                || snapshot.lastPackageName !== (this.packageNamesCache[this.packageNamesCache.length - 1] ?? '')
                || !Array.isArray(snapshot.scopes)
            ) {
                return false;
            }
            const counts = new Map<string, number>();
            const ranges = new Map<string, Array<{ start: number; end: number }>>();
            for (const scope of snapshot.scopes) {
                if (!scope || typeof scope.id !== 'string' || !Array.isArray(scope.ranges)) return false;
                for (const range of scope.ranges) {
                    if (range.start < 0 || range.end < range.start || range.end > this.packageNamesCache.length) return false;
                }
                counts.set(scope.id, this.countScopeRangeEntries(scope.ranges));
                ranges.set(scope.id, scope.ranges.map((range) => ({ ...range })));
            }
            this.scopeCounts = counts;
            this.scopeIds = snapshot.scopes.map((scope) => scope.id);
            this.scopeRanges = ranges;
            this.logger.info('Restored npm scope index snapshot', { scopes: this.scopeIds.length });
            return true;
        } catch {
            return false;
        }
    }

    private async persistScopeIndexSnapshot(): Promise<void> {
        try {
            const cacheDir = this.options.indexCacheDir;
            const snapshotPath = path.join(cacheDir, 'npm-scope-index.json');
            const temporaryPath = `${snapshotPath}.${process.pid}.tmp`;
            const snapshot: ScopeIndexSnapshot = {
                packageCount: this.packageNamesCache.length,
                firstPackageName: this.packageNamesCache[0] ?? '',
                lastPackageName: this.packageNamesCache[this.packageNamesCache.length - 1] ?? '',
                scopes: this.scopeIds.map((id) => {
                    const ranges = this.scopeRanges.get(id)!;
                    return { id, ranges };
                }),
            };
            await mkdir(cacheDir, { recursive: true });
            await writeFile(temporaryPath, JSON.stringify(snapshot), 'utf8');
            await rename(temporaryPath, snapshotPath);
        } catch (error: any) {
            this.logger.warn('Failed to persist npm scope index snapshot', { error: error.message });
        }
    }

    private setupErrorHandling(): void {
        this.app.use(xregistryErrorHandler);
        this.app.use(errorHandler);
    }

    async start(): Promise<void> {
        return new Promise((resolve, reject) => {
            try {
                this.server = require('http').createServer(this.app);
                this.server.listen(this.options.port, this.options.host, () => {
                    this.logger.info('xRegistry NPM Wrapper Server started', {
                        port: this.options.port,
                        host: this.options.host,
                        npmRegistry: this.options.npmRegistryUrl,
                        cacheEnabled: this.options.cacheEnabled,
                    });
                    resolve();
                });

                this.server.on('error', (error: Error) => {
                    this.logger.error('Server error', { error: error.message });
                    reject(error);
                });

                process.on('SIGTERM', () => this.shutdown('SIGTERM'));
                process.on('SIGINT', () => this.shutdown('SIGINT'));
            } catch (error) {
                this.logger.error('Failed to start server', { error });
                reject(error);
            }
        });
    }

    async stop(): Promise<void> {
        this.cacheManager.destroy();
        return new Promise((resolve) => {
            if (this.server) {
                this.server.close(() => {
                    this.logger.info('Server stopped');
                    resolve();
                });
            } else {
                resolve();
            }
        });
    }

    private async shutdown(signal: string): Promise<void> {
        this.logger.info(`Received ${signal}, shutting down gracefully`);
        try {
            await this.stop();
            this.logger.info('Graceful shutdown completed');
            process.exit(0);
        } catch (error) {
            this.logger.error('Error during shutdown', { error });
            process.exit(1);
        }
    }

    getApp(): express.Application {
        return this.app;
    }

    getServer(): any {
        return this.server;
    }
}

export async function createServer(options?: ServerOptions): Promise<XRegistryServer> {
    const server = new XRegistryServer(options);
    await server.start();
    return server;
}

if (require.main === module) {
    const args = process.argv.slice(2);
    let port = parseInt(process.env['PORT'] || '3100', 10);
    let host = process.env['HOST'] || 'localhost';

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--port' && i + 1 < args.length) {
            const portArg = args[i + 1];
            if (portArg) {
                port = parseInt(portArg, 10);
            }
        } else if (args[i] === '--host' && i + 1 < args.length) {
            const hostArg = args[i + 1];
            if (hostArg) {
                host = hostArg;
            }
        }
    }

    createServer({
        port,
        host,
        cacheEnabled: true,
    }).catch((error) => {
        console.error('Failed to start server:', error);
        process.exit(1);
    });
}
