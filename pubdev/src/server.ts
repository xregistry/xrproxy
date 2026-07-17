/**
 * pub.dev xRegistry Server
 * Built on @xregistry/registry-core — createRegistryApp + listenWithGracefulShutdown
 */

import * as path from 'node:path';
import {
  createRegistryApp,
  FileSystemCacheStore,
  isUpstreamError,
  listenWithGracefulShutdown,
} from '@xregistry/registry-core';
import { EntityStateManager } from '../../shared/entity-state-manager';
import {
  CAPABILITIES,
  MODEL,
  REGISTRY_METADATA,
  parsePubDevConfig,
} from './config/constants';
import { createPackageRoutes } from './routes/packages';
import { createXRegistryRoutes } from './routes/xregistry';
import { PackageService } from './services/package-service';
import { PubDevService } from './services/pubdev-service';
import { RegistryService } from './services/registry-service';
import { SearchService } from './services/search-service';

async function main(): Promise<void> {
  const config = parsePubDevConfig();
  // CACHE_DIR env takes precedence (set by Docker/Helm to /app/pubdev/cache),
  // falling back to process.cwd()/cache for local development.
  const cacheDir = process.env['CACHE_DIR'] ?? path.join(process.cwd(), 'cache');

  const store = new FileSystemCacheStore(cacheDir);
  const pubdev = new PubDevService(config.UPSTREAM_URL, store, {
    ttlMs:          config.CACHE_TTL_MS,
    negativeTtlMs:  config.CACHE_NEGATIVE_TTL_MS,
    staleIfErrorMs: config.CACHE_STALE_IF_ERROR_MS,
  }, {
    timeoutMs:          config.UPSTREAM_TIMEOUT_MS,
    operationTimeoutMs: config.UPSTREAM_OPERATION_TIMEOUT_MS,
    maxAttempts:        config.UPSTREAM_MAX_ATTEMPTS,
    concurrency:        config.UPSTREAM_CONCURRENCY,
  });

  const search   = new SearchService(pubdev);
  const entityState = new EntityStateManager();
  const pkgSvc   = new PackageService(pubdev, entityState);
  const regSvc   = new RegistryService(search, entityState);

  // Warm up package list before accepting traffic
  await search.initialize().catch(err =>
    console.warn('[WARN] Search init failed, continuing with fallback:', (err as Error).message),
  );

  const app = createRegistryApp({
    model:        MODEL,
    capabilities: CAPABILITIES,
    readiness:    () => search.isReady(),
    configure(expressApp) {
      expressApp.set('decode_param_values', false);
      expressApp.enable('strict routing');
      expressApp.enable('case sensitive routing');

      // Remove trailing slash
      expressApp.use((req, _res, next) => {
        if (req.path.length > 1 && req.path.endsWith('/')) {
          const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
          req.url = req.path.slice(0, -1) + qs;
        }
        next();
      });

      // CORS
      expressApp.use((_req, res, next) => {
        res.set('Access-Control-Allow-Origin', '*');
        res.set('Access-Control-Expose-Headers', 'ETag, Link, Cache-Control, X-Registry-Id');
        next();
      });

      // Request log
      expressApp.use((req, res, next) => {
        const start = Date.now();
        res.on('finish', () => console.log(`[INFO] ${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - start}ms`));
        next();
      });

      expressApp.use('/', createXRegistryRoutes(regSvc));
      expressApp.use('/', createPackageRoutes(pkgSvc, search, entityState));

      // 405 guard
      expressApp.all(/.*/, (req, res, next) => {
        if (['PUT', 'PATCH', 'POST', 'DELETE'].includes(req.method)) {
          res.status(405).json({ type: 'about:blank', title: 'Method Not Allowed', status: 405, instance: req.path });
        } else {
          next();
        }
      });

      // 404
      expressApp.use((req, res) => {
        const { GROUP_TYPE, GROUP_ID, RESOURCE_TYPE } = REGISTRY_METADATA;
        res.status(404).json({
          type: 'https://github.com/xregistry/spec/blob/main/core/spec.md#entity_not_found',
          title: 'Not Found',
          status: 404,
          instance: req.originalUrl,
          detail: `${req.path} is not defined by this registry`,
          groupType: GROUP_TYPE,
          groupId: GROUP_ID,
          resourceType: RESOURCE_TYPE,
        });
      });
    },

    errorResponse(error: unknown) {
      if (isUpstreamError(error)) {
        if (error.code === 'not_found') {
          return {
            status: 404,
            body: {
              type: 'https://github.com/xregistry/spec/blob/main/core/spec.md#entity_not_found',
              title: error.message,
              status: 404,
              instance: (error.details as Record<string,unknown> | undefined)?.['instance'] ?? '',
            },
          };
        }
        return {
          status: error.status ?? (error.code === 'invalid_response' ? 400 : 502),
          body: { type: 'about:blank', title: error.message, status: error.status ?? 502 },
        };
      }
      return { status: 500, body: { error: 'internal_server_error' } };
    },
  });

  // Patch health to add extra fields
  const { server, close } = await listenWithGracefulShutdown(app, {
    host:              config.HOST,
    port:              config.PORT,
    shutdownTimeoutMs: 10_000,
    onShutdown:        () => search.stop(),
  });

  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : config.PORT;
  console.log(`[INFO] pub.dev xRegistry server listening on port ${port}`);
  console.log(`[INFO] Upstream: ${config.UPSTREAM_URL}`);
  console.log(`[INFO] Health:   http://${config.HOST}:${port}/health`);
  console.log(`[INFO] Model:    http://${config.HOST}:${port}/model`);

  // Suppress unused-var TS warning on close (exported only for tests)
  void close;
}

main().catch(err => {
  console.error('[FATAL] Server startup failed:', err);
  process.exitCode = 1;
});
