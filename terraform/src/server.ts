/**
 * Terraform Registry xRegistry Server
 * Port 3800 · group type: terraformregistries
 * Bootstrapped on @xregistry/registry-core (HTTP, cache, app, shutdown, config)
 */

import * as path from 'path';
import {
    createRegistryApp,
    isUpstreamError,
    listenWithGracefulShutdown,
    parseConfig,
} from '@xregistry/registry-core';
import { EntityStateManager } from '../../shared/entity-state-manager';
import { CAPABILITIES, CACHE_CONFIG } from './config/constants';
import { createModuleRoutes } from './routes/modules';
import { createProviderRoutes } from './routes/providers';
import { createXRegistryRoutes } from './routes/xregistry';
import { ModuleService } from './services/module-service';
import { ProviderService } from './services/provider-service';
import { RegistryService } from './services/registry-service';
import { SearchService } from './services/search-service';
import { TerraformService } from './services/terraform-service';
import modelData from "../model.json";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const CONFIG_SCHEMA = {
    PORT: { type: 'integer', default: 3800, min: 1, max: 65535 },
    HOST: { type: 'string', default: '0.0.0.0', minLength: 1 },
    XREGISTRY_TERRAFORM_PORT: { type: 'integer', default: 3800, min: 1, max: 65535 },
    XREGISTRY_TERRAFORM_QUIET: { type: 'boolean', default: false },
    XREGISTRY_TERRAFORM_API_KEY: { type: 'string' },
    BASE_URL: { type: 'string' },
    XREGISTRY_TERRAFORM_BASEURL: { type: 'string' },
    UPSTREAM_TIMEOUT_MS: { type: 'integer', default: 10_000, min: 1 },
    UPSTREAM_OPERATION_TIMEOUT_MS: { type: 'integer', default: 30_000, min: 1 },
    UPSTREAM_MAX_ATTEMPTS: { type: 'integer', default: 3, min: 1, max: 10 },
    UPSTREAM_CONCURRENCY: { type: 'integer', default: 8, min: 1 },
} as const;

const config = parseConfig(CONFIG_SCHEMA);
const PORT: number = config['PORT'] ?? config['XREGISTRY_TERRAFORM_PORT'] ?? 3800;
const HOST: string = config['HOST'] ?? '0.0.0.0';
const API_KEY: string | undefined = config['XREGISTRY_TERRAFORM_API_KEY'] as string | undefined;

// ---------------------------------------------------------------------------
// Service wiring
// ---------------------------------------------------------------------------
const entityState = new EntityStateManager();
const cacheDir = path.join(__dirname, '..', '..', CACHE_CONFIG.CACHE_DIR_NAME);

const tfService = new TerraformService({
    cacheDir,
    timeoutMs: config['UPSTREAM_TIMEOUT_MS'] as number,
    operationTimeoutMs: config['UPSTREAM_OPERATION_TIMEOUT_MS'] as number,
    maxAttempts: config['UPSTREAM_MAX_ATTEMPTS'] as number,
    concurrency: config['UPSTREAM_CONCURRENCY'] as number,
});

const searchService = new SearchService(tfService);
const providerService = new ProviderService(tfService, entityState);
const moduleService = new ModuleService(tfService, entityState);
const registryService = new RegistryService(searchService, entityState);

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const app = createRegistryApp({
    model: modelData,
    capabilities: CAPABILITIES,
    readiness: () => true,
    configure(express) {
        // Strip trailing slashes
        express.use((req, _res, next) => {
            if (req.path.length > 1 && req.path.endsWith('/')) {
                const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
                req.url = req.path.slice(0, -1) + qs;
            }
            next();
        });

        // Optional Bearer API-key authentication
        if (API_KEY) {
            console.log('[INFO] API key authentication enabled');
            express.use((req, res, next) => {
                if (req.method === 'OPTIONS') return next();
                if (
                    (req.path === '/health' || req.path === '/ready') &&
                    (req.ip === '127.0.0.1' || req.ip === '::1')
                ) return next();
                const auth = req.headers.authorization;
                if (!auth) {
                    return res.status(401).json({
                        type: 'https://github.com/xregistry/spec/blob/main/core/spec.md#unauthorized',
                        title: 'Authentication required',
                        status: 401,
                        instance: req.originalUrl,
                    });
                }
                const [scheme, token] = auth.split(' ');
                if (!/^Bearer$/i.test(scheme) || token !== API_KEY) {
                    return res.status(401).json({
                        type: 'https://github.com/xregistry/spec/blob/main/core/spec.md#unauthorized',
                        title: 'Invalid API key',
                        status: 401,
                        instance: req.originalUrl,
                    });
                }
                next();
            });
        }

        // Mount xRegistry routes
        express.use('/', createXRegistryRoutes(registryService));
        express.use('/', createProviderRoutes(providerService, searchService, entityState));
        express.use('/', createModuleRoutes(moduleService, searchService, entityState));

        // 405 for unsupported write methods on any unmatched route
        express.all(/.*/, (req, res, next) => {
            if (['PUT', 'PATCH', 'POST', 'DELETE'].includes(req.method)) {
                res.status(405).json({
                    type: 'about:blank',
                    title: 'Method Not Allowed',
                    status: 405,
                    detail: `${req.method} is not supported`,
                    instance: req.path,
                });
            } else {
                next();
            }
        });

        // 404 catch-all
        express.use((req, res) => {
            res.status(404).json({
                type: 'https://github.com/xregistry/spec/blob/main/core/spec.md#entity_not_found',
                title: 'Not Found',
                status: 404,
                instance: req.originalUrl,
                detail: `The path ${req.path} was not found`,
            });
        });
    },
    errorResponse: (error) => {
        if (isUpstreamError(error)) {
            const status = error.code === 'not_found' ? 404 : error.code === 'timeout' ? 504 : 502;
            return {
                status,
                body: { type: 'about:blank', title: error.message, status },
            };
        }
        const err = error as Record<string, unknown>;
        if (typeof err['status'] === 'number' && err['type']) {
            return { status: err['status'] as number, body: error };
        }
        return { status: 500, body: { type: 'about:blank', title: 'Internal Server Error', status: 500 } };
    },
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
    // Build a coherent namespace snapshot before advertising readiness.
    await searchService.initialize();
    const { server } = await listenWithGracefulShutdown(app, {
        host: HOST,
        port: PORT,
        shutdownTimeoutMs: 10_000,
        onShutdown: () => {
            searchService.stopPeriodicRefresh();
            console.log('[INFO] Background refresh stopped');
        },
    });
    const addr = server.address();
    const port = addr && typeof addr !== 'string' ? addr.port : PORT;
    console.log(`[INFO] Terraform xRegistry server listening on ${HOST}:${port}`);
}

if (require.main === module) {
    main().catch((err) => {
        console.error('[FATAL] Failed to start server:', err);
        process.exit(1);
    });
}

export default app;
