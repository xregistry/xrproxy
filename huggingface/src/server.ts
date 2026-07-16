/**
 * Hugging Face Hub xRegistry Proxy – main entry point.
 *
 * V1 security contract:
 *   • Anonymous-only: the server NEVER configures or forwards any bearer token.
 *   • Any incoming request that carries an Authorization header is rejected
 *     immediately with 400 Bad Request before routing to any handler.
 *   • The HF API is always called without any Authorization header.
 */

import express, { type NextFunction, type Request, type Response } from 'express';
import {
  createRegistryApp,
  HttpUpstreamClient,
  listenWithGracefulShutdown,
} from '@xregistry/registry-core';
import * as modelData from '../model.json';
import { parseHfConfig } from './config';
import { HuggingFaceClient } from './hf-client';
import { setupRoutes } from './routes/index';

// ─── Configuration ──────────────────────────────────────────────────────────

const config = parseHfConfig();

// ─── Anonymous-only enforcement middleware ───────────────────────────────────
// MUST be installed before any route handler so that no handler ever sees a
// credentialed request.

function requireAnonymous(req: Request, res: Response, next: NextFunction): void {
  const auth = req.headers['authorization'];
  if (auth) {
    res.status(400).json({
      type: 'about:blank',
      title: 'Credentials not accepted',
      detail:
        'This proxy operates in anonymous-only mode. ' +
        'Bearer tokens and other credentials are not accepted and are never forwarded.',
      status: 400,
    });
    return;
  }
  next();
}

// ─── HTTP client (no auth headers ever) ─────────────────────────────────────

const httpClient = new HttpUpstreamClient({
  timeoutMs: config.UPSTREAM_TIMEOUT_MS,
  operationTimeoutMs: config.UPSTREAM_OPERATION_TIMEOUT_MS,
  maxAttempts: config.UPSTREAM_MAX_ATTEMPTS,
  concurrency: config.UPSTREAM_CONCURRENCY,
});

const hfClient = HuggingFaceClient.withFileCache(
  httpClient,
  config.HF_API_URL,
  config.CACHE_DIR,
  config.MUTABLE_CACHE_TTL_MS,
  config.IMMUTABLE_CACHE_TTL_MS,
);

// ─── Build the Express application ───────────────────────────────────────────

const app = createRegistryApp({
  model: modelData,
  capabilities: {
    apis: ['/capabilities', '/model', '/health', '/ready'],
    flags: ['inline', 'filter', 'sort'],
    mutable: false,
    pagination: true,
    specversions: ['1.0-rc2'],
  },
  configure(expressApp: express.Express) {
    // 1. Reject any credentialed request before routing
    expressApp.use(requireAnonymous);

    // 2. CORS – allow all origins (read-only registry)
    expressApp.use((_req: Request, res: Response, next: NextFunction) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Accept, Accept-Encoding, Content-Type, User-Agent');
      if (_req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Max-Age', '86400');
        res.status(204).end();
        return;
      }
      next();
    });

    // 3. Inject xRegistry spec version header
    expressApp.use((_req: Request, res: Response, next: NextFunction) => {
      res.setHeader('xRegistry-Version', '1.0-rc2');
      next();
    });

    // 4. Domain routes
    setupRoutes(expressApp, config, hfClient);
  },
  errorResponse(error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[HF] Unhandled error:', msg);
    return { status: 500, body: { type: 'about:blank', title: 'Internal Server Error', status: 500 } };
  },
});

// ─── Start server ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { server } = await listenWithGracefulShutdown(app, {
    host: config.HOST,
    port: config.PORT,
    shutdownTimeoutMs: 10_000,
    onShutdown() {
      console.log('[HF] Graceful shutdown complete.');
    },
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : config.PORT;
  console.log(`[HF] Hugging Face Hub xRegistry proxy listening on ${config.HOST}:${port}`);
  console.log(`[HF] HF API URL: ${config.HF_API_URL}`);
  console.log('[HF] Anonymous-only mode: bearer tokens are rejected.');
}

main().catch(err => {
  console.error('[HF] Fatal startup error:', err);
  process.exitCode = 1;
});
