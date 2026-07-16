import { createRegistryApp, isUpstreamError, listenWithGracefulShutdown, UpstreamError } from '@xregistry/registry-core';
import { CratesIoAdapter } from './adapter';
import { parseCratesConfig } from './config';
import { FixtureAdapter } from './fixtures';
import { CAPABILITIES, MODEL } from './model';
import { registerRoutes } from './routes';

function mapError(error: unknown): { readonly status: number; readonly body: unknown } {
  if (isUpstreamError(error)) {
    const err = error as UpstreamError;
    if (err.code === 'not_found') {
      return { status: 404, body: { error: 'not_found', message: err.message } };
    }
    if (err.code === 'rate_limited') {
      return {
        status: 429,
        body: {
          error: 'rate_limited',
          message: err.message,
          ...(err.retryAfterMs !== undefined ? { retryAfterMs: err.retryAfterMs } : {})
        }
      };
    }
    return { status: 502, body: { error: err.code, message: err.message } };
  }
  return { status: 500, body: { error: 'internal_server_error' } };
}

async function main(): Promise<void> {
  const config = parseCratesConfig(process.env);

  const adapter = config.FIXTURE_MODE
    ? new FixtureAdapter()
    : new CratesIoAdapter({
        baseUrl: config.UPSTREAM_URL,
        timeoutMs: config.UPSTREAM_TIMEOUT_MS,
        operationTimeoutMs: config.UPSTREAM_OPERATION_TIMEOUT_MS,
        maxAttempts: config.UPSTREAM_MAX_ATTEMPTS,
        concurrency: config.UPSTREAM_CONCURRENCY
      });

  const app = createRegistryApp({
    model: MODEL,
    capabilities: CAPABILITIES,
    readiness: () => true,
    configure(expressApp) {
      registerRoutes(expressApp, adapter, {
        ttlMs: config.CACHE_TTL_MS,
        negativeTtlMs: config.CACHE_NEGATIVE_TTL_MS,
        staleIfErrorMs: config.CACHE_STALE_IF_ERROR_MS,
        cacheDir: config.CACHE_DIR
      });
    },
    errorResponse: mapError
  });

  const running = await listenWithGracefulShutdown(app, {
    host: config.HOST,
    port: config.PORT
  });

  const address = running.server.address();
  const port = address && typeof address !== 'string' ? address.port : config.PORT;
  console.log(`[crates] Listening on ${config.HOST}:${port}`);
  console.log(`[crates] Upstream: ${config.UPSTREAM_URL}`);
  console.log(`[crates] Fixture mode: ${config.FIXTURE_MODE}`);
}

main().catch(error => {
  console.error('[crates] Fatal error:', error);
  process.exitCode = 1;
});
