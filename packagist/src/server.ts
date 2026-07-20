/**
 * xRegistry Packagist wrapper.
 *
 * Composer vendors are xRegistry groups and package basenames are resources.
 * Exact package lookup is always resolved directly against Packagist and does
 * not depend on the discovery catalogue.
 */

import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import {
    FileSystemCacheStore,
    HttpUpstreamClient,
    TtlCache,
    createRegistryApp,
    expandRegistryModel,
    isUpstreamError,
    listenWithGracefulShutdown,
    parseConfig,
} from '@xregistry/registry-core';
import model from '../model.json';
import {
    CAPABILITIES,
    GROUP_CONFIG,
    REGISTRY_CONFIG,
    RESOURCE_CONFIG,
    getBaseUrl,
} from './config/constants';
import { corsMiddleware } from './middleware/cors';
import { createSimpleLogger } from './middleware/logging';
import { asyncHandler, throwEntityNotFound } from './middleware/xregistry-error-handler';
import { applyFilter, applySort, parseXRegistryFlags } from './middleware/xregistry-flags';
import { PackagistService } from './services/packagist-service';
import { EntityStateManager } from '../../shared/entity-state-manager';
import { entityETag } from './utils/xregistry-utils';
import {
    decodeLegacyPackageId,
    identityToPackageName,
} from './utils/package-utils';
import { invalidData, isXRegistryError } from './utils/xregistry-errors';

const config = parseConfig({
    HOST: { type: 'string', default: '0.0.0.0', minLength: 1 },
    PORT: { type: 'integer', default: 4100, min: 1, max: 65535 },
    PACKAGIST_URL: { type: 'url', default: 'https://packagist.org', protocols: ['http:', 'https:'] },
    CACHE_DIR: { type: 'string', default: './cache', minLength: 1 },
    CACHE_TTL_MS: { type: 'integer', default: 6 * 60 * 60 * 1000, min: 0 },
    CACHE_NEGATIVE_TTL_MS: { type: 'integer', default: 30_000, min: 0 },
    CACHE_STALE_IF_ERROR_MS: { type: 'integer', default: 900_000, min: 0 },
    UPSTREAM_TIMEOUT_MS: { type: 'integer', default: 10_000, min: 1 },
    UPSTREAM_OPERATION_TIMEOUT_MS: { type: 'integer', default: 30_000, min: 1 },
});

const API_KEY = process.env['XREGISTRY_PACKAGIST_API_KEY'] ?? null;
const log = createSimpleLogger();
const store = new FileSystemCacheStore(config.CACHE_DIR);
const cache = new TtlCache(store, {
    ttlMs: config.CACHE_TTL_MS,
    negativeTtlMs: config.CACHE_NEGATIVE_TTL_MS,
    staleIfErrorMs: config.CACHE_STALE_IF_ERROR_MS,
});
const http = new HttpUpstreamClient({
    timeoutMs: config.UPSTREAM_TIMEOUT_MS,
    operationTimeoutMs: config.UPSTREAM_OPERATION_TIMEOUT_MS,
});
const packagistService = new PackagistService({
    packagistBaseUrl: config.PACKAGIST_URL,
    http,
    cache,
});
const entityState = new EntityStateManager();

/** A collection request can hydrate at most one capped response page. */
const MAX_RESOURCE_HYDRATIONS = 100;
const PACKAGE_CATALOG_ATTRIBUTES = new Set([
    'packageid', 'vendor', 'name', 'packagepath', 'xid', 'epoch',
]);

function requestedFilterAttributes(filter: string[][] | undefined): string[] {
    return (filter ?? []).flat().map(expression =>
        (expression.split(expression.includes('!=') ? '!=' : '=')[0] ?? '').trim().toLowerCase(),
    );
}

function assertBoundedPackageQuery(req: Request): void {
    const flags = req.xregistryFlags ?? {};
    const unsupported = requestedFilterAttributes(flags.filter)
        .filter(attribute => !PACKAGE_CATALOG_ATTRIBUTES.has(attribute));
    if (flags.sort && !PACKAGE_CATALOG_ATTRIBUTES.has(flags.sort.attribute.toLowerCase())) {
        unsupported.push(flags.sort.attribute);
    }
    if (unsupported.length > 0) {
        throw invalidData(
            req.originalUrl,
            'filter',
            `Package-wide metadata filtering/sorting is unsupported because it would require unbounded upstream hydration. Supported collection attributes: ${[...PACKAGE_CATALOG_ATTRIBUTES].join(', ')}. Unsupported: ${[...new Set(unsupported)].join(', ')}.`,
        );
    }
}

function sendEntity(req: Request, res: Response, entity: unknown): void {
    const etag = entityETag(entity);
    res.setHeader('ETag', etag);
    if (req.headers['if-none-match'] === etag) {
        res.status(304).end();
        return;
    }
    res.json(entity);
}

/** RFC 8288 pagination links preserving supported query parameters. */
function buildPaginationLinks(req: Request, offset: number, total: number, limit: number): string | undefined {
    if (total <= limit && offset === 0) return undefined;
    const base = `${getBaseUrl(req)}${req.path}`;
    const makeUrl = (nextOffset: number): string => {
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(req.query)) {
            if (Array.isArray(value)) {
                for (const entry of value) if (typeof entry === 'string') params.append(key, entry);
            } else if (typeof value === 'string') {
                params.set(key, value);
            }
        }
        params.delete('page');
        params.set('offset', String(nextOffset));
        params.set('limit', String(limit));
        return `${base}?${params.toString()}`;
    };
    const links: string[] = [];
    if (offset > 0) {
        links.push(`<${makeUrl(0)}>; rel="first"`);
        links.push(`<${makeUrl(Math.max(0, offset - limit))}>; rel="prev"`);
    }
    if (offset + limit < total) {
        links.push(`<${makeUrl(offset + limit)}>; rel="next"`);
        links.push(`<${makeUrl(Math.floor((total - 1) / limit) * limit)}>; rel="last"`);
    }
    return links.length ? links.join(', ') : undefined;
}

function setCollectionHeaders(req: Request, res: Response, offset: number, total: number, limit: number): void {
    res.setHeader('X-Total-Count', String(total));
    const links = buildPaginationLinks(req, offset, total, limit);
    if (links) res.setHeader('Link', links);
}

function resolvePackageIdentity(req: Request, groupId: string, packageId: string): string {
    try {
        return identityToPackageName(groupId, packageId);
    } catch {
        throw invalidData(
            req.originalUrl,
            'packageid',
            'Composer paths use /composerregistries/{vendor}/packages/{package}; entity IDs cannot contain slashes.',
        );
    }
}

function originalQuery(req: Request): string {
    const queryIndex = req.originalUrl.indexOf('?');
    return queryIndex === -1 ? '' : req.originalUrl.slice(queryIndex);
}

function canonicalPackageUrl(
    req: Request,
    pkg: Record<string, unknown>,
    suffix = '',
): string {
    return `${getBaseUrl(req)}/${GROUP_CONFIG.TYPE}/${encodeURIComponent(String(pkg['vendor']))}/${RESOURCE_CONFIG.TYPE}/${encodeURIComponent(String(pkg['packageid']))}${suffix}${originalQuery(req)}`;
}

function redirectCanonicalPackage(
    req: Request,
    res: Response,
    pkg: Record<string, unknown>,
    groupId: string,
    packageId: string,
    suffix = '',
): boolean {
    if (pkg['vendor'] !== groupId || pkg['packageid'] !== packageId) {
        res.redirect(308, canonicalPackageUrl(req, pkg, suffix));
        return true;
    }
    return false;
}

function migrationSuffix(segments: readonly string[]): string {
    return segments.slice(4).map(segment => `/${encodeURIComponent(segment)}`).join('');
}

function sendLegacyMigration(req: Request, res: Response, segments: readonly string[]): void {
    const packageId = segments[3];
    const legacy = packageId ? decodeLegacyPackageId(packageId) : null;
    const resourceType = segments[2] === RESOURCE_CONFIG.TYPE ? segments[2] : RESOURCE_CONFIG.TYPE;
    const suffix = migrationSuffix(segments);
    const replacement = legacy
        ? `/${GROUP_CONFIG.TYPE}/${encodeURIComponent(legacy.groupId)}/${resourceType}/${encodeURIComponent(legacy.resourceId)}${suffix}`
        : `/${GROUP_CONFIG.TYPE}/{vendor}/${resourceType}/{package}${suffix}`;
    res.status(410).json({
        type: 'https://github.com/xregistry/xrproxy/issues/203',
        title: 'Packagist path migrated',
        status: 410,
        instance: req.originalUrl,
        detail: 'The fixed packagist.org group and vendor~package resource IDs were removed.',
        replacement,
    });
}

const app: Express = createRegistryApp({
    model,
    capabilities: CAPABILITIES,
    errorResponse: (error) => {
        if (isUpstreamError(error)) {
            const status = error.code === 'not_found'
                ? 404
                : error.code === 'timeout'
                    ? 504
                    : 502;
            return { status, body: { type: 'about:blank', title: error.message, status, instance: '/' } };
        }
        if (isXRegistryError(error)) return { status: error.status, body: error };
        return { status: 500, body: { type: 'about:blank', title: 'Internal Server Error', status: 500 } };
    },
    configure(app) {
        app.set('trust proxy', true);
        app.use(express.json({ limit: '10mb' }));
        app.use(corsMiddleware);
        app.use(parseXRegistryFlags);

        app.use((req: Request, res: Response, next: NextFunction) => {
            let segments: string[];
            try {
                segments = req.originalUrl.split('?', 1)[0]!.split('/').filter(Boolean).map(segment => decodeURIComponent(segment));
            } catch {
                res.status(400).json({ type: 'about:blank', title: 'Malformed URL encoding', status: 400, instance: req.originalUrl });
                return;
            }
            // A case-only mismatch is an xRegistry miss, not a migration alias.
            if (
                segments[0] === GROUP_CONFIG.TYPE &&
                segments[1]?.toLowerCase() === GROUP_CONFIG.LEGACY_ID &&
                segments[1] !== GROUP_CONFIG.LEGACY_ID
            ) {
                res.status(404).json({ type: 'about:blank', title: 'Not Found', status: 404, instance: req.originalUrl });
                return;
            }
            // Only the old namespace-bearing Resource shape is reserved. A real
            // Composer vendor named "packagist.org" remains addressable.
            if (
                segments[0] === GROUP_CONFIG.TYPE &&
                segments[1] === GROUP_CONFIG.LEGACY_ID &&
                segments[2] === RESOURCE_CONFIG.TYPE &&
                segments[3]?.includes('~')
            ) {
                sendLegacyMigration(req, res, segments);
                return;
            }
            next();
        });

        app.use((_req: Request, res: Response, next: NextFunction) => {
            const originalWriteHead = res.writeHead.bind(res);
            // @ts-ignore Express overload replacement
            res.writeHead = function (statusCode: number, ...rest: unknown[]) {
                const ct = this.getHeader('Content-Type');
                if (ct && String(ct).startsWith('application/json')) {
                    this.setHeader('Content-Type', 'application/json; schema="https://xregistry.io/schemas/xregistry-v1.0-rc2.json"');
                }
                // @ts-ignore Express overload replacement
                return originalWriteHead(statusCode, ...rest);
            };
            next();
        });

        if (API_KEY) {
            app.use((req: Request, res: Response, next: NextFunction): void => {
                const key = req.get('x-api-key') ?? req.query['apikey'];
                if (key !== API_KEY) {
                    res.status(401).json({ type: 'about:blank', title: 'Unauthorized', status: 401, instance: req.originalUrl });
                    return;
                }
                next();
            });
        }

        app.get('/', asyncHandler(async (req, res) => {
            const base = getBaseUrl(req);
            const flags = req.xregistryFlags ?? {};
            let vendorCount: number | undefined;
            try {
                vendorCount = (await packagistService.listVendors()).length;
            } catch {
                // Bootstrap remains available during an upstream outage; an unknown count is omitted.
            }
            const registry: Record<string, unknown> = {
                specversion: REGISTRY_CONFIG.SPEC_VERSION,
                registryid: REGISTRY_CONFIG.ID,
                xid: '/',
                self: `${base}/`,
                name: 'Packagist xRegistry Service',
                description: 'Composer packages grouped by their Packagist vendor namespace.',
                documentation: 'https://packagist.org',
                epoch: entityState.getEpoch('/'),
                createdat: entityState.getCreatedAt('/'),
                modifiedat: entityState.getModifiedAt('/'),
                [`${GROUP_CONFIG.TYPE}url`]: `${base}/${GROUP_CONFIG.TYPE}`,
                ...(vendorCount !== undefined ? { [`${GROUP_CONFIG.TYPE}count`]: vendorCount } : {}),
            };
            if (flags.inline?.includes('*') || flags.inline?.includes('model')) registry['model'] = expandRegistryModel(model);
            if (flags.inline?.includes('*') || flags.inline?.includes('modelsource')) registry['modelsource'] = model;
            sendEntity(req, res, registry);
        }));

        app.get(`/${GROUP_CONFIG.TYPE}`, asyncHandler(async (req, res) => {
            const base = getBaseUrl(req);
            const flags = req.xregistryFlags ?? {};
            const offset = flags.offset ?? 0;
            const limit = flags.limit ?? 15;
            let vendors: Record<string, unknown>[] = (await packagistService.listVendors()).map(({ id, packagescount }) => {
                const groupPath = `/${GROUP_CONFIG.TYPE}/${id}`;
                return packagistService.buildGroupEntity(base, id, packagescount, {
                    createdat: entityState.getCreatedAt(groupPath),
                    modifiedat: entityState.getModifiedAt(groupPath),
                });
            });
            const q = typeof req.query['q'] === 'string' ? req.query['q'].toLowerCase() : '';
            if (q) vendors = vendors.filter(item => String(item['name']).toLowerCase().includes(q));
            if (flags.filter) vendors = applyFilter(vendors, flags.filter);
            if (flags.sort) vendors = applySort(vendors, flags.sort);
            const total = vendors.length;
            const response: Record<string, unknown> = {};
            for (const vendor of vendors.slice(offset, offset + limit)) {
                response[vendor[`${GROUP_CONFIG.TYPE_SINGULAR}id`] as string] = vendor;
            }
            setCollectionHeaders(req, res, offset, total, limit);
            sendEntity(req, res, response);
        }));

        app.get(`/${GROUP_CONFIG.TYPE}/:groupId`, asyncHandler(async (req, res) => {
            const { groupId } = req.params as { groupId: string };
            const vendor = (await packagistService.listVendors()).find(item => item.id === groupId);
            if (!vendor) throwEntityNotFound(req.originalUrl, 'composerregistry', groupId);
            const base = getBaseUrl(req);
            const groupPath = `/${GROUP_CONFIG.TYPE}/${groupId}`;
            sendEntity(req, res, packagistService.buildGroupEntity(base, groupId, vendor.packagescount, {
                createdat: entityState.getCreatedAt(groupPath),
                modifiedat: entityState.getModifiedAt(groupPath),
            }));
        }));

        app.get(`/${GROUP_CONFIG.TYPE}/:groupId/${RESOURCE_CONFIG.TYPE}`, asyncHandler(async (req, res) => {
            const { groupId } = req.params as { groupId: string };
            const flags = req.xregistryFlags ?? {};
            const offset = flags.offset ?? 0;
            const limit = flags.limit ?? 15;
            assertBoundedPackageQuery(req);
            const discovered = await packagistService.listVendorPackages(groupId);
            if (discovered.length === 0) throwEntityNotFound(req.originalUrl, 'composerregistry', groupId);
            const base = getBaseUrl(req);
            let items: Record<string, unknown>[] = discovered.map(item => ({ ...item, epoch: 1 }));
            items = items.filter(item => item['vendor'] === groupId);
            const q = typeof req.query['q'] === 'string' ? req.query['q'].toLowerCase() : '';
            if (q) items = items.filter(item => String(item['name']).toLowerCase().includes(q));
            if (flags.filter) items = applyFilter(items, flags.filter);
            if (flags.sort) items = applySort(items, flags.sort);
            const total = items.length;

            const selectedNames = items.slice(offset, offset + limit).map(item => String(item['packagepath']));
            // parseXRegistryFlags caps limit at MAX_RESOURCE_HYDRATIONS, so
            // this is the only bounded fan-out performed by a collection read.
            const selected = (await Promise.all(selectedNames.slice(0, MAX_RESOURCE_HYDRATIONS)
                .map(name => packagistService.getPackageResource(name, base))))
                .filter((item): item is NonNullable<typeof item> => item !== null);
            const response: Record<string, unknown> = {};
            for (const item of selected) response[String(item['packageid'])] = item;
            setCollectionHeaders(req, res, offset, total, limit);
            sendEntity(req, res, response);
        }));

        app.get(`/${GROUP_CONFIG.TYPE}/:groupId/${RESOURCE_CONFIG.TYPE}/:packageId`, asyncHandler(async (req, res) => {
            const { groupId, packageId } = req.params as { groupId: string; packageId: string };
            const vendorPackage = resolvePackageIdentity(req, groupId, packageId);
            const base = getBaseUrl(req);
            const pkg = await packagistService.getPackageResource(vendorPackage, base);
            if (!pkg) throwEntityNotFound(req.originalUrl, 'package', vendorPackage);
            if (redirectCanonicalPackage(req, res, pkg, groupId, packageId)) return;
            const canonicalName = `${String(pkg['vendor'])}/${String(pkg['packageid'])}`;
            const response: Record<string, unknown> = { ...pkg };
            const flags = req.xregistryFlags ?? {};
            if (flags.inline?.includes('*') || flags.inline?.includes('versions')) {
                const versions = await packagistService.getVersions(canonicalName, base);
                response['versions'] = Object.fromEntries(versions.map(version => [version.versionid, version]));
            }
            sendEntity(req, res, response);
        }));

        app.get(`/${GROUP_CONFIG.TYPE}/:groupId/${RESOURCE_CONFIG.TYPE}/:packageId/meta`, asyncHandler(async (req, res) => {
            const { groupId, packageId } = req.params as { groupId: string; packageId: string };
            const vendorPackage = resolvePackageIdentity(req, groupId, packageId);
            const pkg = await packagistService.getPackageResource(vendorPackage, getBaseUrl(req));
            if (!pkg) throwEntityNotFound(req.originalUrl, 'package', vendorPackage);
            if (redirectCanonicalPackage(req, res, pkg, groupId, packageId, '/meta')) return;
            const meta = await packagistService.getPackageMeta(vendorPackage, getBaseUrl(req));
            if (!meta) throwEntityNotFound(req.originalUrl, 'package', vendorPackage);
            sendEntity(req, res, meta);
        }));

        app.get(`/${GROUP_CONFIG.TYPE}/:groupId/${RESOURCE_CONFIG.TYPE}/:packageId/versions`, asyncHandler(async (req, res) => {
            const { groupId, packageId } = req.params as { groupId: string; packageId: string };
            const vendorPackage = resolvePackageIdentity(req, groupId, packageId);
            const base = getBaseUrl(req);
            const pkg = await packagistService.getPackageResource(vendorPackage, base);
            if (!pkg) throwEntityNotFound(req.originalUrl, 'package', vendorPackage);
            if (redirectCanonicalPackage(req, res, pkg, groupId, packageId, '/versions')) return;
            const canonicalName = `${String(pkg['vendor'])}/${String(pkg['packageid'])}`;
            const flags = req.xregistryFlags ?? {};
            let versions = await packagistService.getVersions(canonicalName, base);
            if (flags.filter) versions = applyFilter(versions as unknown as Record<string, unknown>[], flags.filter) as unknown as typeof versions;
            versions = flags.sort
                ? applySort(versions as unknown as Record<string, unknown>[], flags.sort) as unknown as typeof versions
                : [...versions].sort((a, b) =>
                    a.versionid.localeCompare(b.versionid, undefined, { sensitivity: 'base' }) ||
                    a.versionid.localeCompare(b.versionid),
                );
            const total = versions.length;
            const offset = flags.offset ?? 0;
            const limit = flags.limit ?? 15;
            const response = Object.fromEntries(
                versions.slice(offset, offset + limit).map(version => [version.versionid, version]),
            );
            setCollectionHeaders(req, res, offset, total, limit);
            sendEntity(req, res, response);
        }));

        app.get(`/${GROUP_CONFIG.TYPE}/:groupId/${RESOURCE_CONFIG.TYPE}/:packageId/versions/:versionId`, asyncHandler(async (req, res) => {
            const { groupId, packageId, versionId } = req.params as { groupId: string; packageId: string; versionId: string };
            const vendorPackage = resolvePackageIdentity(req, groupId, packageId);
            const base = getBaseUrl(req);
            const pkg = await packagistService.getPackageResource(vendorPackage, base);
            if (!pkg) throwEntityNotFound(req.originalUrl, 'package', vendorPackage);
            if (redirectCanonicalPackage(req, res, pkg, groupId, packageId, `/versions/${encodeURIComponent(versionId)}`)) return;
            const canonicalName = `${String(pkg['vendor'])}/${String(pkg['packageid'])}`;
            const version = await packagistService.getVersion(canonicalName, versionId, base);
            if (!version) throwEntityNotFound(req.originalUrl, 'version', versionId);
            sendEntity(req, res, version);
        }));

        app.use((req: Request, res: Response) => {
            res.status(404).json({ type: 'about:blank', title: 'Not Found', status: 404, instance: req.originalUrl });
        });
    },
});

async function main(): Promise<void> {
    await listenWithGracefulShutdown(app, {
        host: config.HOST,
        port: config.PORT,
        onShutdown: () => log.info('HTTP server closed; shutdown complete'),
    });
    log.info(`Packagist xRegistry proxy listening on ${config.HOST}:${config.PORT}`);
}

if (require.main === module) {
    main().catch((error) => {
        log.error('Fatal startup error', { error: error instanceof Error ? error.message : String(error) });
        process.exit(1);
    });
}

export { app };
