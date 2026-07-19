import assert from 'node:assert/strict';
import test from 'node:test';
import { createRegistryApp, isUpstreamError, listenWithGracefulShutdown, UpstreamError } from '@xregistry/registry-core';
import { FixtureAdapter } from '../../src/fixtures';
import { CAPABILITIES, MODEL } from '../../src/model';
import { registerRoutes } from '../../src/routes';

function mapError(error: unknown): { readonly status: number; readonly body: unknown } {
  if (isUpstreamError(error)) {
    const err = error as UpstreamError;
    if (err.code === 'not_found') return { status: 404, body: { error: 'not_found' } };
    if (err.code === 'rate_limited') return { status: 429, body: { error: 'rate_limited' } };
    return { status: 502, body: { error: err.code } };
  }
  return { status: 500, body: { error: 'internal_server_error' } };
}

async function startTestServer(): Promise<{ readonly base: string; readonly close: () => Promise<void> }> {
  const adapter = new FixtureAdapter();
  const app = createRegistryApp({
    model: MODEL,
    capabilities: CAPABILITIES,
    readiness: () => true,
    configure(expressApp) {
      registerRoutes(expressApp, adapter, {
        ttlMs: 0,
        negativeTtlMs: 0,
        staleIfErrorMs: 0,
        cacheDir: './cache/test'
      });
    },
    errorResponse: mapError
  });
  const running = await listenWithGracefulShutdown(app, {
    host: '127.0.0.1',
    port: 0,
    signals: []
  });
  const address = running.server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: running.close
  };
}

test('GET /health returns ok', async () => {
  const server = await startTestServer();
  try {
    const response = await fetch(`${server.base}/health`);
    assert.equal(response.status, 200);
    const body = await response.json() as { status: string };
    assert.equal(body.status, 'ok');
  } finally {
    await server.close();
  }
});

test('GET /ready returns ready', async () => {
  const server = await startTestServer();
  try {
    const response = await fetch(`${server.base}/ready`);
    assert.equal(response.status, 200);
    const body = await response.json() as { status: string };
    assert.equal(body.status, 'ready');
  } finally {
    await server.close();
  }
});

test('GET /model returns model with rustregistries', async () => {
  const server = await startTestServer();
  try {
    const response = await fetch(`${server.base}/model`);
    assert.equal(response.status, 200);
    const body = await response.json() as { groups?: { rustregistries?: unknown } };
    assert.ok(body.groups?.rustregistries, 'model must have rustregistries group');
  } finally {
    await server.close();
  }
});

test('GET /capabilities returns capabilities', async () => {
  const server = await startTestServer();
  try {
    const response = await fetch(`${server.base}/capabilities`);
    assert.equal(response.status, 200);
    const body = await response.json() as { schemas?: unknown[] };
    assert.ok(Array.isArray(body.schemas), 'capabilities must have schemas array');
  } finally {
    await server.close();
  }
});

test('GET / returns registry root', async () => {
  const server = await startTestServer();
  try {
    const response = await fetch(`${server.base}/`);
    assert.equal(response.status, 200);
    const body = await response.json() as Record<string, unknown>;
    assert.equal(body['registryid'], 'crates.io');
    assert.ok(typeof body['rustregistriesurl'] === 'string');
    assert.equal(body['rustregistriescount'], 1);
  } finally {
    await server.close();
  }
});

test('GET /rustregistries/crates.io omits non-authoritative resource count', async () => {
  const server = await startTestServer();
  try {
    const response = await fetch(`${server.base}/rustregistries/crates.io`);
    assert.equal(response.status, 200);
    const body = await response.json() as Record<string, unknown>;
    // crates.io has 175k+ crates; a page-bounded proxy cannot emit an authoritative count
    assert.equal(body['cratescount'], undefined, 'group must not emit cratescount');
    assert.ok(typeof body['cratesurl'] === 'string');
  } finally {
    await server.close();
  }
});

test('GET /rustregistries returns group collection', async () => {
  const server = await startTestServer();
  try {
    const response = await fetch(`${server.base}/rustregistries`);
    assert.equal(response.status, 200);
    const body = await response.json() as Record<string, unknown>;
    assert.ok(body['crates.io'], 'crates.io group must be present');
  } finally {
    await server.close();
  }
});

test('GET /rustregistries/crates.io returns single group', async () => {
  const server = await startTestServer();
  try {
    const response = await fetch(`${server.base}/rustregistries/crates.io`);
    assert.equal(response.status, 200);
    const body = await response.json() as Record<string, unknown>;
    assert.ok(typeof body['cratesurl'] === 'string');
    assert.equal(body['epoch'], 1);
  } finally {
    await server.close();
  }
});

test('GET /rustregistries/unknown returns 404', async () => {
  const server = await startTestServer();
  try {
    const response = await fetch(`${server.base}/rustregistries/pypi.org`);
    assert.equal(response.status, 404);
    const body = await response.json() as { error: string };
    assert.equal(body.error, 'not_found');
  } finally {
    await server.close();
  }
});

test('GET /rustregistries/crates.io/crates returns crate list', async () => {
  const server = await startTestServer();
  try {
    const response = await fetch(`${server.base}/rustregistries/crates.io/crates`);
    assert.equal(response.status, 200);
    const body = await response.json() as Record<string, unknown>;
    assert.ok(body['serde'], 'serde fixture must be present');
    assert.ok(body['tokio'], 'tokio fixture must be present');
  } finally {
    await server.close();
  }
});

test('GET /rustregistries/crates.io/crates/serde returns crate', async () => {
  const server = await startTestServer();
  try {
    const response = await fetch(`${server.base}/rustregistries/crates.io/crates/serde`);
    assert.equal(response.status, 200);
    const body = await response.json() as Record<string, unknown>;
    assert.equal(body['crateid'], 'serde');
    assert.equal(body['versionid'], '1.0.219');
    assert.equal(body['isdefault'], true);
    assert.equal(body['max_version'], '1.0.219');
    assert.equal(body['immutable'], undefined, 'crate-level should not have immutable flag');
    assert.ok(typeof body['versionsurl'] === 'string');
  } finally {
    await server.close();
  }
});

test('GET /rustregistries/crates.io/crates/unknown returns 404', async () => {
  const server = await startTestServer();
  try {
    const response = await fetch(`${server.base}/rustregistries/crates.io/crates/nonexistent-xyz-crate`);
    assert.equal(response.status, 404);
    const body = await response.json() as { error: string };
    assert.equal(body.error, 'not_found');
  } finally {
    await server.close();
  }
});

test('GET /rustregistries/crates.io/crates/serde/versions returns version list', async () => {
  const server = await startTestServer();
  try {
    const response = await fetch(`${server.base}/rustregistries/crates.io/crates/serde/versions`);
    assert.equal(response.status, 200);
    const body = await response.json() as Record<string, unknown>;
    assert.ok(body['1.0.219'], '1.0.219 version must be present');
    const v = body['1.0.219'] as Record<string, unknown>;
    assert.equal(v['immutable'], true, 'version must be immutable');
    assert.equal(v['isdefault'], true, '1.0.219 must be default');
  } finally {
    await server.close();
  }
});

test('GET version detail returns full version object', async () => {
  const server = await startTestServer();
  try {
    const response = await fetch(`${server.base}/rustregistries/crates.io/crates/serde/versions/1.0.219`);
    assert.equal(response.status, 200);
    const body = await response.json() as Record<string, unknown>;
    assert.equal(body['versionid'], '1.0.219');
    assert.equal(body['immutable'], true);
    assert.equal(body['yanked'], false);
    assert.equal(body['license'], 'MIT OR Apache-2.0');
    assert.ok(body['self']);
    assert.ok(body['xid']);
  } finally {
    await server.close();
  }
});

test('GET unknown version returns 404', async () => {
  const server = await startTestServer();
  try {
    const response = await fetch(`${server.base}/rustregistries/crates.io/crates/serde/versions/0.0.0`);
    assert.equal(response.status, 404);
  } finally {
    await server.close();
  }
});

test('pagination params are bounded — limit above MAX_PAGE_SIZE returns max', async () => {
  const server = await startTestServer();
  try {
    const response = await fetch(`${server.base}/rustregistries/crates.io/crates?limit=9999`);
    assert.equal(response.status, 200);
  } finally {
    await server.close();
  }
});

test('crate collection honors offset pagination and emits navigation links', async () => {
  const server = await startTestServer();
  try {
    const first = await fetch(`${server.base}/rustregistries/crates.io/crates?offset=0&limit=1`);
    const second = await fetch(`${server.base}/rustregistries/crates.io/crates?offset=1&limit=1`);
    const firstBody = await first.json() as Record<string, unknown>;
    const secondBody = await second.json() as Record<string, unknown>;
    assert.deepEqual(Object.keys(firstBody), ['serde']);
    assert.deepEqual(Object.keys(secondBody), ['tokio']);
    assert.match(first.headers.get('link') ?? '', /offset=1/);
    assert.match(second.headers.get('link') ?? '', /rel="prev"/);
  } finally {
    await server.close();
  }
});

test('crate collection supports name prefix filters', async () => {
  const server = await startTestServer();
  try {
    const response = await fetch(`${server.base}/rustregistries/crates.io/crates?filter=name=ser*`);
    const body = await response.json() as Record<string, unknown>;
    assert.deepEqual(Object.keys(body), ['serde']);
  } finally {
    await server.close();
  }
});

test('name prefix filtering paginates over matches rather than upstream pages', async () => {
  const server = await startTestServer();
  try {
    const response = await fetch(`${server.base}/rustregistries/crates.io/crates?filter=name=tok*&offset=0&limit=1`);
    const body = await response.json() as Record<string, unknown>;
    assert.deepEqual(Object.keys(body), ['tokio']);
    assert.equal(response.headers.get('link'), null);
  } finally {
    await server.close();
  }
});

test('name prefix filtering rejects offsets outside the crates.io search window', async () => {
  const server = await startTestServer();
  try {
    const response = await fetch(`${server.base}/rustregistries/crates.io/crates?filter=name=tok*&offset=1000&limit=1`);
    assert.equal(response.status, 400);
    const body = await response.json() as Record<string, unknown>;
    assert.equal(body['error'], 'invalid_offset');
    assert.match(String(body['message']), /less than 1000/);
    assert.equal(response.headers.get('link'), null);
  } finally {
    await server.close();
  }
});

test('version collection honors offset pagination', async () => {
  const server = await startTestServer();
  try {
    const response = await fetch(`${server.base}/rustregistries/crates.io/crates/serde/versions?offset=1&limit=1`);
    const body = await response.json() as Record<string, unknown>;
    assert.deepEqual(Object.keys(body), ['1.0.218']);
    assert.match(response.headers.get('link') ?? '', /rel="prev"/);
  } finally {
    await server.close();
  }
});
