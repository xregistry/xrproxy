/**
 * Go Module xRegistry Proxy — main server entry point.
 *
 * Serves xRegistry 1.0-rc2 endpoints for Go modules:
 *   - Group type: goregistries   Resource type: modules
 *   - Exact lookup via the GOPROXY protocol (proxy.golang.org).
 *   - Discovery via the append-only Go index (index.golang.org) with a
 *     resumable checkpoint stored in a provider-neutral JSON catalog.
 *
 * Built on @xregistry/registry-core (createRegistryApp + graceful shutdown).
 */

import * as path from 'node:path';
import type { Express, ErrorRequestHandler } from 'express';
import { createRegistryApp, listenWithGracefulShutdown } from '@xregistry/registry-core';
import { EntityStateManager } from '../../shared/entity-state-manager';
import { loadConfig, REGISTRY_METADATA, MODEL_STRUCTURE } from './config/constants';
import { corsMiddleware } from './middleware/cors';
import { loggingMiddleware } from './middleware/logging';
import { xregistryErrorHandler } from './middleware/xregistry-error-handler';
import { createModuleRoutes } from './routes/modules';
import { createXRegistryRoutes } from './routes/xregistry';
import { CheckpointService } from './services/checkpoint-service';
import { GoModuleService } from './services/go-module-service';
import { ModuleService } from './services/module-service';
import { RegistryService } from './services/registry-service';

// Reference REGISTRY_METADATA so downstream tooling keeps the export live.
void REGISTRY_METADATA;

const cfg = loadConfig();

// Resolve cache dir relative to CWD (works in both dev and Docker where CWD=/app/gomod)
const cacheDir = path.resolve(cfg.CACHE_DIR);

const entityState = new EntityStateManager();
const checkpointSvc = new CheckpointService(cacheDir);
const goSvc = new GoModuleService(checkpointSvc, {
  proxyBaseUrl: cfg.GOPROXY_URL,
  indexBaseUrl: cfg.GO_INDEX_URL,
  indexPageLimit: cfg.INDEX_PAGE_LIMIT,
  indexMaxPages: cfg.INDEX_MAX_PAGES,
  indexRefreshMs: cfg.INDEX_REFRESH_MS,
});
const moduleSvc = new ModuleService(goSvc, checkpointSvc, entityState);
const registrySvc = new RegistryService(checkpointSvc, entityState);

const capabilities = {
  apis: ['/capabilities', '/model', '/export'],
  flags: ['doc', 'epoch', 'filter', 'inline', 'sort', 'specversion'],
  formats: ['xRegistry-json/1.0-rc2'],
  mutable: [],
  pagination: true,
  specversions: ['1.0-rc2'],
};

/**
 * createRegistryApp registers a minimal `/health` (`{status:'ok'}`) before it
 * invokes `configure`. Express serves the first matching route, so the richer
 * `/health` added below would be shadowed. Remove the core layer so the
 * service-specific health payload (`status:'healthy'`, catalog stats) is served.
 */
function promoteHealthRoute(a: Express): void {
  const stack = ((a as unknown as { router?: { stack: any[] } }).router
    ?? (a as unknown as { _router?: { stack: any[] } })._router)?.stack;
  if (!stack) return;
  for (let i = 0; i < stack.length; i += 1) {
    if (stack[i]?.route?.path === '/health') {
      stack.splice(i, 1);
      return;
    }
  }
}

const app = createRegistryApp({
  model: MODEL_STRUCTURE,
  capabilities,
  readiness: () => true,
  configure: (a) => {
    a.set('trust proxy', true);
    a.use(corsMiddleware);
    a.use(loggingMiddleware);

    // Optional API key guard (before business routes)
    if (cfg.API_KEY) {
      a.use((_req, res, next) => {
        const hdr = _req.get('Authorization') ?? _req.get('x-api-key') ?? '';
        const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : hdr;
        if (token !== cfg.API_KEY) {
          res.status(401).json({ type: 'about:blank', title: 'Unauthorized', status: 401, instance: _req.originalUrl });
          return;
        }
        next();
      });
    }

    // Override /health with richer payload (core's minimal /health is pruned below)
    a.get('/health', (_req, res) => {
      res.json({
        status: 'healthy',
        service: 'xregistry-gomod-proxy',
        timestamp: new Date().toISOString(),
        uptime: Math.floor(process.uptime()),
        catalog: {
          moduleCount: checkpointSvc.getModuleCount(),
          entryCount: checkpointSvc.getEntryCount(),
          checkpoint: checkpointSvc.getCheckpoint().since,
        },
      });
    });

    a.use('/', createXRegistryRoutes(registrySvc));
    a.use('/', createModuleRoutes(moduleSvc, checkpointSvc));
    a.use(xregistryErrorHandler as ErrorRequestHandler);
  },
});

promoteHealthRoute(app);

listenWithGracefulShutdown(app, {
  host: cfg.HOST,
  port: cfg.PORT,
  shutdownTimeoutMs: 10_000,
  onShutdown: () => { goSvc.stopIndexRefresh(); },
}).then(({ server }) => {
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : cfg.PORT;
  console.log(`[gomod] xRegistry Go Module Proxy on http://${cfg.HOST}:${port}`);
  console.log(`[gomod] GOPROXY=${cfg.GOPROXY_URL}  INDEX=${cfg.GO_INDEX_URL}`);
  console.log(`[gomod] cache=${cacheDir}`);
  goSvc.startIndexRefresh();
}).catch(err => {
  console.error('[gomod] Failed to start:', err);
  process.exit(1);
});

export { app };
