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
        cacheDir: './cache/test',
        sourceUrl: 'https://index.crates.io'
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
    assert.equal(body['registryid'], 'crates-io');
    assert.ok(typeof body['rustregistriesurl'] === 'string');
    assert.equal(body['rustregistriescount'], 1);
  } finally {
    await server.close();
  }
});

test('GET /rustregistries/crates-io returns the crates-io projection', async () => {
  const server = await startTestServer();
  try {
    const response = await fetch(`${server.base}/rustregistries/crates-io`);
    assert.equal(response.status, 200);
    const body = await response.json() as Record<string, unknown>;
    assert.equal(body['rustregistryid'], 'crates-io');
    assert.equal(body['sourceurl'], 'https://index.crates.io');
    assert.equal(body['cratescount'], undefined, 'group must not emit a synthetic cratescount');
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
    assert.ok(body['crates-io'], 'crates-io group must be present');
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

test('GET /rustregistries/crates-io/crates returns spec-shaped crate resources', async () => {
  const server = await startTestServer();
  try {
    const response = await fetch(`${server.base}/rustregistries/crates-io/crates`);
    assert.equal(response.status, 200);
    const body = await response.json() as Record<string, Record<string, unknown>>;
    assert.ok(body['serde'], 'serde fixture must be present');
    assert.ok(body['tokio'], 'tokio fixture must be present');
    assert.equal(body['serde']?.versionid, '1.0.218');
    assert.equal((body['serde']?.meta as Record<string, unknown>).default_version, '1.0.218');
    assert.equal(body['tokio']?.versionid, '1.45.1~exp.sha.1');
  } finally {
    await server.close();
  }
});

test('GET /rustregistries/crates-io/crates/serde returns default-version fields at the resource root', async () => {
  const server = await startTestServer();
  try {
    const response = await fetch(`${server.base}/rustregistries/crates-io/crates/serde`);
    assert.equal(response.status, 200);
    const body = await response.json() as Record<string, unknown>;
    const meta = body['meta'] as Record<string, unknown>;
    assert.equal(body['crateid'], 'serde');
    assert.equal(body['versionid'], '1.0.218');
    assert.equal(body['downloads'], 3_000_000);
    assert.equal(body['createdat'], '2024-12-01T00:00:00.000Z');
    assert.equal(body['modifiedat'], '2024-12-01T00:00:00.000Z');
    assert.equal(body['max_version'], undefined, 'deprecated crate-level pointers belong in meta');
    assert.equal(body['recent_downloads'], undefined, 'crate statistics belong in meta');
    assert.equal(body['owners'], undefined, 'owners belong in meta');
    assert.equal(body['crate_links'], undefined, 'crate links belong in meta');
    assert.equal(body['links'], undefined, 'links was renamed to crate_links in meta');
    assert.equal(body['isdefault'], undefined, 'resource root must not expose version-only isdefault');
    assert.equal(body['immutable'], undefined, 'resource root must not expose version-only immutable');
    assert.equal(body['versionscount'], 2);
    assert.ok(typeof body['metaurl'] === 'string');
    assert.equal(meta['default_version'], '1.0.218');
    assert.equal(meta['max_version'], '1.0.219');
    assert.equal(meta['max_stable_version'], '1.0.219');
    assert.equal(meta['newest_version'], '1.0.219');
    assert.equal(meta['downloads'], 450_000_000);
    assert.equal(meta['recent_downloads'], 12_000_000);
    assert.equal(meta['num_versions'], 2);
    assert.equal(meta['yanked'], false);
    assert.equal(meta['trustpub_only'], true);
    assert.equal(meta['defaultversionid'], '1.0.218');
    assert.equal(meta['defaultversionsticky'], false);
    assert.equal(meta['createdat'], '2015-01-17T17:47:12.000Z');
    assert.equal(meta['modifiedat'], '2025-01-02T00:00:00.000Z');
    assert.deepEqual(meta['owners'], [
      {
        id: 3618,
        login: 'dtolnay',
        name: 'David Tolnay',
        kind: 'user',
        url: 'https://github.com/dtolnay',
        avatar: 'https://avatars.githubusercontent.com/u/1940490?v=4'
      },
      {
        id: 8138,
        login: 'github:serde-rs:publish',
        name: 'publish',
        kind: 'team',
        url: 'https://github.com/serde-rs',
        avatar: 'https://avatars.githubusercontent.com/u/11965399?v=4'
      }
    ]);
    assert.deepEqual(meta['crate_links'], {
      version_downloads: '/api/v1/crates/serde/downloads',
      versions: '/api/v1/crates/serde/versions',
      owners: '/api/v1/crates/serde/owners',
      owner_team: '/api/v1/crates/serde/owner_team',
      owner_user: '/api/v1/crates/serde/owner_user',
      reverse_dependencies: '/api/v1/crates/serde/reverse_dependencies'
    });
  } finally {
    await server.close();
  }
});

test('GET /rustregistries/crates-io/crates/serde/meta returns the crate meta document', async () => {
  const server = await startTestServer();
  try {
    const response = await fetch(`${server.base}/rustregistries/crates-io/crates/serde/meta`);
    assert.equal(response.status, 200);
    const body = await response.json() as Record<string, unknown>;
    assert.equal(body['crateid'], 'serde');
    assert.equal(body['readonly'], true);
    assert.equal(body['compatibility'], 'none');
    assert.equal(body['defaultversionsticky'], false);
    assert.equal(body['xid'], '/rustregistries/crates-io/crates/serde/meta');
    assert.equal(body['ancestor'], undefined);
  } finally {
    await server.close();
  }
});

test('GET /rustregistries/crates-io/crates/unknown returns 404', async () => {
  const server = await startTestServer();
  try {
    const response = await fetch(`${server.base}/rustregistries/crates-io/crates/nonexistent-xyz-crate`);
    assert.equal(response.status, 404);
    const body = await response.json() as { error: string };
    assert.equal(body.error, 'not_found');
  } finally {
    await server.close();
  }
});

test('GET /rustregistries/crates-io/crates/serde/versions returns yanked and default versions keyed by versionid', async () => {
  const server = await startTestServer();
  try {
    const response = await fetch(`${server.base}/rustregistries/crates-io/crates/serde/versions`);
    assert.equal(response.status, 200);
    const body = await response.json() as Record<string, Record<string, unknown>>;
    assert.ok(body['1.0.219'], '1.0.219 version must be present');
    assert.ok(body['1.0.218'], '1.0.218 version must be present');
    assert.equal(body['1.0.219']?.immutable, true, 'version must be immutable');
    assert.equal(body['1.0.219']?.isdefault, false, 'yanked 1.0.219 must not be default');
    assert.equal(body['1.0.219']?.yanked, true, 'yanked versions remain listed');
    assert.equal(body['1.0.218']?.isdefault, true, 'default_version drives isdefault');
  } finally {
    await server.close();
  }
});

test('GET version detail returns full version object with dependencies and provenance', async () => {
  const server = await startTestServer();
  try {
    const response = await fetch(`${server.base}/rustregistries/crates-io/crates/serde/versions/1.0.218`);
    assert.equal(response.status, 200);
    const body = await response.json() as Record<string, unknown>;
    assert.equal(body['versionid'], '1.0.218');
    assert.equal(body['immutable'], true);
    assert.equal(body['yanked'], false);
    assert.equal(body['license'], 'MIT OR Apache-2.0');
    assert.equal(body['cksum'], '2182182182182182182182182182182182182182182182182182182182182182');
    assert.deepEqual(body['features2'], { unstable: ['dep:serde_derive'] });
    assert.deepEqual(body['dependencies'], [{
      name: 'serde_derive_alias',
      req: '^1.0',
      features: ['std'],
      optional: true,
      default_features: false,
      target: 'cfg(unix)',
      kind: 'dev',
      registry: 'https://example.invalid/index',
      package: 'serde_derive'
    }]);
    assert.deepEqual(body['published_by'], undefined);
    assert.ok(body['self']);
    assert.ok(body['xid']);
  } finally {
    await server.close();
  }
});

test('build-metadata version routes use ~ in versionid while preserving num', async () => {
  const server = await startTestServer();
  try {
    const response = await fetch(`${server.base}/rustregistries/crates-io/crates/tokio/versions/1.45.1~exp.sha.1`);
    assert.equal(response.status, 200);
    const body = await response.json() as Record<string, unknown>;
    assert.equal(body['versionid'], '1.45.1~exp.sha.1');
    assert.equal(body['num'], '1.45.1+exp.sha.1');
    assert.equal(body['isdefault'], true);
    assert.equal(body['lib_links'], 'tokio_native');
  } finally {
    await server.close();
  }
});

test('GET unknown version returns 404', async () => {
  const server = await startTestServer();
  try {
    const response = await fetch(`${server.base}/rustregistries/crates-io/crates/serde/versions/0.0.0`);
    assert.equal(response.status, 404);
  } finally {
    await server.close();
  }
});

test('pagination params are bounded — limit above MAX_PAGE_SIZE returns max', async () => {
  const server = await startTestServer();
  try {
    const response = await fetch(`${server.base}/rustregistries/crates-io/crates?limit=9999`);
    assert.equal(response.status, 200);
  } finally {
    await server.close();
  }
});

test('crate collection honors offset pagination and emits navigation links', async () => {
  const server = await startTestServer();
  try {
    const first = await fetch(`${server.base}/rustregistries/crates-io/crates?offset=0&limit=1`);
    const second = await fetch(`${server.base}/rustregistries/crates-io/crates?offset=1&limit=1`);
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
    const response = await fetch(`${server.base}/rustregistries/crates-io/crates?filter=name=ser*`);
    const body = await response.json() as Record<string, unknown>;
    assert.deepEqual(Object.keys(body), ['serde']);
  } finally {
    await server.close();
  }
});

test('name prefix filtering paginates over matches rather than upstream pages', async () => {
  const server = await startTestServer();
  try {
    const response = await fetch(`${server.base}/rustregistries/crates-io/crates?filter=name=tok*&offset=0&limit=1`);
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
    const response = await fetch(`${server.base}/rustregistries/crates-io/crates?filter=name=tok*&offset=1000&limit=1`);
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
    const response = await fetch(`${server.base}/rustregistries/crates-io/crates/serde/versions?offset=1&limit=1`);
    const body = await response.json() as Record<string, unknown>;
    assert.deepEqual(Object.keys(body), ['1.0.218']);
    assert.match(response.headers.get('link') ?? '', /rel="prev"/);
  } finally {
    await server.close();
  }
});
