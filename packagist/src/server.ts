/**
 * xRegistry Packagist Wrapper Server
 *
 * Implements xRegistry 1.0-rc2 for Packagist/Composer packages.
 * Group type: composerregistries
 * Default port: 4100
 *
 * Built on the shared `@xregistry/registry-core` runtime:
 *   - createRegistryApp / listenWithGracefulShutdown for the HTTP lifecycle
 *   - FileSystemCacheStore + TtlCache for upstream response caching
 *   - HttpUpstreamClient for resilient upstream fetches (global fetch)
 *   - parseConfig for validated configuration
 *   - UpstreamError / isUpstreamError for typed error mapping
 *
 * Identity rules for versions:
 *   - Stable releases (1.x.y, …): immutable, stable versionid
 *   - dev-* branch aliases: mutable; versionid includes source reference for
 *     collision safety
 */

import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import {
    FileSystemCacheStore,
    HttpUpstreamClient,
    TtlCache,
    createRegistryApp,
    isUpstreamError,
    listenWithGracefulShutdown,
    parseConfig,
} from '@xregistry/registry-core';
import model from '../model.json';
import {
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
import { decodePackageId } from './utils/package-utils';
import { isXRegistryError } from './utils/xregistry-errors';

// ─── Configuration ────────────────────────────────────────────────────────────

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

// ─── Services ───────────────────────────────────────────────────────────────

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

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Send a JSON entity with a deterministic SHA-256 ETag, honoring
 * If-None-Match with a 304 response when the client already has the entity.
 * Returns true when a 304 was sent (caller should stop).
 */
function sendEntity(req: Request, res: Response, entity: unknown): void {
    const etag = entityETag(entity);
    res.setHeader('ETag', etag);
    if (req.headers['if-none-match'] === etag) {
        res.status(304).end();
        return;
    }
    res.json(entity);
}

/** Build RFC 5988 pagination links, preserving all existing query parameters. */
function buildPaginationLinks(req: Request, page: number, total: number, perPage: number): string {
    const totalPages = Math.ceil(total / perPage);
    const base = `${getBaseUrl(req)}${req.path}`;
    const makeUrl = (p: number): string => {
        const params = new URLSearchParams(req.query as Record<string, string>);
        params.set('page', String(p));
        return `${base}?${params.toString()}`;
    };
    const links: string[] = [];
    if (page < totalPages) links.push(`<${makeUrl(page + 1)}>; rel="next"`);
    if (page > 1) links.push(`<${makeUrl(page - 1)}>; rel="prev"`);
    links.push(`<${makeUrl(1)}>; rel="first"`);
    if (totalPages > 0) links.push(`<${makeUrl(totalPages)}>; rel="last"`);
    return links.join(', ');
}

// ─── Application ────────────────────────────────────────────────────────────

const app: Express = createRegistryApp({
    model,
    capabilities: {
        specversions: [REGISTRY_CONFIG.SPEC_VERSION],
        pagination: true,
        filtering: true,
        sorting: true,
        inlining: true,
    },
    errorResponse: (error) => {
        if (isUpstreamError(error)) {
            const status = error.code === 'not_found'
                ? 404
                : error.code === 'rate_limited'
                    ? 502
                    : error.code === 'timeout'
                        ? 504
                        : 502;
            return { status, body: { type: 'about:blank', title: error.message, status, instance: '/' } };
        }
        if (isXRegistryError(error)) {
            return { status: error.status, body: error };
        }
        return { status: 500, body: { type: 'about:blank', title: 'Internal Server Error', status: 500 } };
    },
    configure(app) {
        app.set('trust proxy', true);
        app.use(express.json({ limit: '10mb' }));
        app.use(corsMiddleware);
        app.use(parseXRegistryFlags);

        // Inject the xRegistry schema parameter into every application/json response.
        app.use((_req: Request, res: Response, next: NextFunction) => {
            const originalWriteHead = res.writeHead.bind(res);
            // @ts-ignore – overriding writeHead signature
            res.writeHead = function (statusCode: number, ...rest: unknown[]) {
                const ct = this.getHeader('Content-Type');
                if (ct && String(ct).startsWith('application/json')) {
                    this.setHeader('Content-Type', 'application/json; schema="https://xregistry.io/schemas/xregistry-v1.0-rc2.json"');
                }
                // @ts-ignore
                return originalWriteHead(statusCode, ...rest);
            };
            next();
        });

        // Optional API-key authentication.
        if (API_KEY) {
            app.use((req: Request, res: Response, next: NextFunction): void => {
                const key = req.get('x-api-key') ?? req.query['apikey'];
                if (key !== API_KEY) {
                    res.status(401).json({
                        type: 'about:blank',
                        title: 'Unauthorized',
                        status: 401,
                        instance: req.originalUrl,
                    });
                    return;
                }
                next();
            });
        }

        // ─── Registry root (/): discovery document ─────────────────────────

        app.get('/', asyncHandler(async (req, res) => {
            const base = getBaseUrl(req);
            const flags = req.xregistryFlags ?? {};

            const registry: Record<string, unknown> = {
                specversion: REGISTRY_CONFIG.SPEC_VERSION,
                registryid: REGISTRY_CONFIG.ID,
                xid: '/',
                self: base,
                name: 'Packagist xRegistry Service',
                description: 'xRegistry-compliant Composer/Packagist package registry',
                documentation: 'https://packagist.org',
                epoch: entityState.getEpoch('/'),
                createdat: entityState.getCreatedAt('/'),
                modifiedat: entityState.getModifiedAt('/'),
                modelurl: `${base}/model`,
                capabilitiesurl: `${base}/capabilities`,
                [`${GROUP_CONFIG.TYPE}url`]: `${base}/${GROUP_CONFIG.TYPE}`,
                [`${GROUP_CONFIG.TYPE}count`]: 1,
            };

            if (flags.inline?.includes('*') || flags.inline?.includes('model')) {
                registry['model'] = model;
            }
            sendEntity(req, res, registry);
        }));

        // ─── /composerregistries ────────────────────────────────────────────

        app.get(`/${GROUP_CONFIG.TYPE}`, asyncHandler(async (req, res) => {
            const base = getBaseUrl(req);
            const groupPath = `/${GROUP_CONFIG.TYPE}/${GROUP_CONFIG.ID}`;
            const group = packagistService.buildGroupEntity(base, {
                createdat: entityState.getCreatedAt(groupPath),
                modifiedat: entityState.getModifiedAt(groupPath),
            });
            const response: Record<string, unknown> = { [GROUP_CONFIG.ID]: group };
            sendEntity(req, res, response);
        }));

        // ─── /composerregistries/packagist.org ───────────────────────────────

        app.get(`/${GROUP_CONFIG.TYPE}/:groupId`, asyncHandler(async (req, res) => {
            const { groupId } = req.params as { groupId: string };
            if (groupId !== GROUP_CONFIG.ID) {
                throwEntityNotFound(req.originalUrl, 'composerregistry', groupId);
            }
            const base = getBaseUrl(req);
            const groupPath = `/${GROUP_CONFIG.TYPE}/${GROUP_CONFIG.ID}`;
            const group = packagistService.buildGroupEntity(base, {
                createdat: entityState.getCreatedAt(groupPath),
                modifiedat: entityState.getModifiedAt(groupPath),
            });
            sendEntity(req, res, group);
        }));

        // ─── /composerregistries/packagist.org/packages ──────────────────────

        app.get(`/${GROUP_CONFIG.TYPE}/:groupId/${RESOURCE_CONFIG.TYPE}`, asyncHandler(async (req, res) => {
            const { groupId } = req.params as { groupId: string };
            if (groupId !== GROUP_CONFIG.ID) {
                throwEntityNotFound(req.originalUrl, 'composerregistry', groupId);
            }

            const flags = req.xregistryFlags ?? {};
            const q = (req.query['q'] as string | undefined) ?? '';
            const pageStr = req.query['page'] as string | undefined;
            const page = pageStr ? Math.max(1, parseInt(pageStr, 10)) : 1;

            const perPage = 15;
            const { packages, total } = await packagistService.searchPackages(q, page, perPage);

            const base = getBaseUrl(req);

            let items: Record<string, unknown>[] = packages.map(entry => {
                const selfUrl = `${base}/${GROUP_CONFIG.TYPE}/${GROUP_CONFIG.ID}/${RESOURCE_CONFIG.TYPE}/${entry.packageid}`;
                return {
                    xid: `/${GROUP_CONFIG.TYPE}/${GROUP_CONFIG.ID}/${RESOURCE_CONFIG.TYPE}/${entry.packageid}`,
                    self: selfUrl,
                    packageid: entry.packageid,
                    name: entry.name,
                    description: entry.description,
                    epoch: 1,
                    versionsurl: `${selfUrl}/versions`,
                };
            });

            if (flags.filter) {
                items = applyFilter(items, flags.filter) as typeof items;
            }
            if (flags.sort) {
                items = applySort(items, flags.sort) as typeof items;
            }

            const response: Record<string, unknown> = {};
            for (const item of items) {
                response[item['packageid'] as string] = item;
            }
            res.setHeader('Link', buildPaginationLinks(req, page, total, perPage));
            sendEntity(req, res, response);
        }));

        // ─── /composerregistries/packagist.org/packages/:packageId ────────────

        app.get(`/${GROUP_CONFIG.TYPE}/:groupId/${RESOURCE_CONFIG.TYPE}/:packageId`, asyncHandler(async (req, res) => {
            const { groupId, packageId } = req.params as { groupId: string; packageId: string };
            if (groupId !== GROUP_CONFIG.ID) {
                throwEntityNotFound(req.originalUrl, 'composerregistry', groupId);
            }

            const vendorPackage = decodePackageId(packageId);
            const base = getBaseUrl(req);
            const pkg = await packagistService.getPackageResource(vendorPackage, base);
            if (!pkg) throwEntityNotFound(req.originalUrl, 'package', packageId);

            const flags = req.xregistryFlags ?? {};
            const response: Record<string, unknown> = { ...pkg };

            if (flags.inline?.includes('*') || flags.inline?.includes('versions')) {
                const versions = await packagistService.getVersions(vendorPackage, base);
                const versionsMap: Record<string, unknown> = {};
                for (const v of versions) {
                    versionsMap[v.versionid] = v;
                }
                response['versions'] = versionsMap;
            }
            sendEntity(req, res, response);
        }));

        // ─── /…/packages/:packageId/meta ──────────────────────────────────────

        app.get(`/${GROUP_CONFIG.TYPE}/:groupId/${RESOURCE_CONFIG.TYPE}/:packageId/meta`, asyncHandler(async (req, res) => {
            const { groupId, packageId } = req.params as { groupId: string; packageId: string };
            if (groupId !== GROUP_CONFIG.ID) throwEntityNotFound(req.originalUrl, 'composerregistry', groupId);

            const vendorPackage = decodePackageId(packageId);
            const base = getBaseUrl(req);
            const pkg = await packagistService.getPackageResource(vendorPackage, base);
            if (!pkg) throwEntityNotFound(req.originalUrl, 'package', packageId);

            const meta: Record<string, unknown> = {
                xid: `${pkg['xid']}/meta`,
                self: `${pkg['self']}/meta`,
                readonly: true,
                compatibility: 'none',
                epoch: 1,
                createdat: pkg['createdat'],
                modifiedat: pkg['modifiedat'],
                defaultversionid: pkg['currentVersion'],
            };
            sendEntity(req, res, meta);
        }));

        // ─── /…/packages/:packageId/versions ──────────────────────────────────

        app.get(`/${GROUP_CONFIG.TYPE}/:groupId/${RESOURCE_CONFIG.TYPE}/:packageId/versions`, asyncHandler(async (req, res) => {
            const { groupId, packageId } = req.params as { groupId: string; packageId: string };
            if (groupId !== GROUP_CONFIG.ID) throwEntityNotFound(req.originalUrl, 'composerregistry', groupId);

            const vendorPackage = decodePackageId(packageId);
            const base = getBaseUrl(req);
            const flags = req.xregistryFlags ?? {};

            let versions = await packagistService.getVersions(vendorPackage, base);
            if (!versions.length) throwEntityNotFound(req.originalUrl, 'package', packageId);

            if (flags.filter) {
                versions = applyFilter(versions as unknown as Record<string, unknown>[], flags.filter) as unknown as typeof versions;
            }
            if (flags.sort) {
                versions = applySort(versions as unknown as Record<string, unknown>[], flags.sort) as unknown as typeof versions;
            }

            const response: Record<string, unknown> = {};
            for (const v of versions) {
                response[v.versionid] = v;
            }
            sendEntity(req, res, response);
        }));

        // ─── /…/packages/:packageId/versions/:versionId ───────────────────────

        app.get(`/${GROUP_CONFIG.TYPE}/:groupId/${RESOURCE_CONFIG.TYPE}/:packageId/versions/:versionId`, asyncHandler(async (req, res) => {
            const { groupId, packageId, versionId } = req.params as {
                groupId: string; packageId: string; versionId: string;
            };
            if (groupId !== GROUP_CONFIG.ID) throwEntityNotFound(req.originalUrl, 'composerregistry', groupId);

            const vendorPackage = decodePackageId(packageId);
            const base = getBaseUrl(req);
            const version = await packagistService.getVersion(vendorPackage, versionId, base);
            if (!version) throwEntityNotFound(req.originalUrl, 'version', versionId);
            sendEntity(req, res, version);
        }));

        // ─── 404 catch-all ─────────────────────────────────────────────────────

        app.use((req: Request, res: Response) => {
            res.status(404).json({
                type: 'about:blank',
                title: 'Not Found',
                status: 404,
                instance: req.originalUrl,
            });
        });
    },
});

// ─── Start ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    await listenWithGracefulShutdown(app, {
        host: config.HOST,
        port: config.PORT,
        onShutdown: () => {
            log.info('HTTP server closed; shutdown complete');
        },
    });
    log.info(`Packagist xRegistry proxy listening on ${config.HOST}:${config.PORT}`);
    log.info(`Upstream: ${config.PACKAGIST_URL}`);
    log.info(`Cache TTL: ${config.CACHE_TTL_MS / 1000}s`);
}

if (require.main === module) {
    main().catch((error) => {
        log.error('Fatal startup error', { error: error instanceof Error ? error.message : String(error) });
        process.exit(1);
    });
}

export { app };
