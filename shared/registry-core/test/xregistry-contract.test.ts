import assert from 'node:assert/strict';
import test from 'node:test';
import { createRegistryApp, listenWithGracefulShutdown, UpstreamError } from '../src';

test('standard xRegistry bootstrap endpoints follow their response contracts', async () => {
  const model = { groups: { packages: { resources: {} } } };
  const capabilities = { schemas: ['https://xregistry.io/specification/registry/model'] };
  const app = createRegistryApp({
    model,
    capabilities,
    readiness: () => true,
    configure(expressApp) {
      expressApp.get('/mapped-error', (_request, _response, next) => {
        next(new UpstreamError({
          code: 'rate_limited',
          message: 'limited',
          status: 429,
          retryAfterMs: 1000
        }));
      });
      expressApp.get('/default-error', (_request, _response, next) => {
        next(new Error('do not expose'));
      });
    },
    errorResponse(error) {
      if (error instanceof UpstreamError) {
        return {
          status: error.status ?? 502,
          body: { error: error.code, retryAfterMs: error.retryAfterMs }
        };
      }
      return { status: 500, body: { error: 'internal_server_error' } };
    }
  });
  const running = await listenWithGracefulShutdown(app, {
    host: '127.0.0.1',
    port: 0,
    signals: []
  });
  try {
    const address = running.server.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const expectations = [
      ['/health', 200, { status: 'ok' }],
      ['/ready', 200, { status: 'ready' }],
      ['/model', 200, model],
      ['/capabilities', 200, capabilities],
      ['/mapped-error', 429, { error: 'rate_limited', retryAfterMs: 1000 }],
      ['/default-error', 500, { error: 'internal_server_error' }]
    ] as const;
    for (const [path, status, body] of expectations) {
      const response = await fetch(`${base}${path}`);
      assert.equal(response.status, status, path);
      assert.match(response.headers.get('content-type') ?? '', /^application\/json\b/, path);
      assert.deepEqual(await response.json(), body, path);
    }
  } finally {
    await running.close();
  }
});
