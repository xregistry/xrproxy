import assert from 'node:assert/strict';
import test from 'node:test';
import { startFixtureServer } from '@xregistry/registry-core';
import { CratesIoAdapter } from '../../src/adapter';
import { FIXTURE_CRATE_SERDE, FIXTURE_LIST, FIXTURE_VERSIONS_SERDE } from '../../src/fixtures';

test('CratesIoAdapter lists crates from upstream', async () => {
  const fixture = await startFixtureServer([{
    method: 'GET',
    path: '/api/v1/crates',
    responses: [{ body: FIXTURE_LIST }]
  }]);
  try {
    const adapter = new CratesIoAdapter({
      baseUrl: fixture.url,
      timeoutMs: 5000,
      operationTimeoutMs: 10000,
      maxAttempts: 1,
      concurrency: 4
    });
    const result = await adapter.listCrates({ page: 1, perPage: 25 });
    assert.equal(result.kind, 'value');
    if (result.kind === 'value') {
      assert.equal(result.value.crates.length, 2);
      assert.equal(result.value.crates[0]?.name, 'serde');
    }
  } finally {
    await fixture.close();
  }
});

test('CratesIoAdapter gets a single crate from upstream', async () => {
  const fixture = await startFixtureServer([{
    method: 'GET',
    path: '/api/v1/crates/serde',
    responses: [{ body: FIXTURE_CRATE_SERDE, etag: '"serde-etag-1"' }]
  }]);
  try {
    const adapter = new CratesIoAdapter({
      baseUrl: fixture.url,
      timeoutMs: 5000,
      operationTimeoutMs: 10000,
      maxAttempts: 1,
      concurrency: 4
    });
    const result = await adapter.getCrate('serde');
    assert.equal(result.kind, 'value');
    if (result.kind === 'value') {
      assert.equal(result.value.crate.name, 'serde');
      assert.equal(result.value.crate.max_version, '1.0.219');
      assert.equal(result.etag, '"serde-etag-1"');
    }
  } finally {
    await fixture.close();
  }
});

test('CratesIoAdapter returns not-found for missing crate', async () => {
  const fixture = await startFixtureServer([{
    method: 'GET',
    path: '/api/v1/crates/nonexistent',
    responses: [{ status: 404, body: { errors: [{ detail: 'Not Found' }] } }]
  }]);
  try {
    const adapter = new CratesIoAdapter({
      baseUrl: fixture.url,
      timeoutMs: 5000,
      operationTimeoutMs: 10000,
      maxAttempts: 1,
      concurrency: 4
    });
    const result = await adapter.getCrate('nonexistent');
    assert.equal(result.kind, 'not-found');
  } finally {
    await fixture.close();
  }
});

test('CratesIoAdapter honors conditional ETag (304 not-modified)', async () => {
  const fixture = await startFixtureServer([{
    method: 'GET',
    path: '/api/v1/crates/serde',
    responses: [{ body: FIXTURE_CRATE_SERDE, etag: '"etag-v1"' }]
  }]);
  try {
    const adapter = new CratesIoAdapter({
      baseUrl: fixture.url,
      timeoutMs: 5000,
      operationTimeoutMs: 10000,
      maxAttempts: 1,
      concurrency: 4
    });
    const result = await adapter.getCrate('serde', { etag: '"etag-v1"' });
    assert.equal(result.kind, 'not-modified');
    const requests = fixture.requests;
    const lastReq = requests[requests.length - 1];
    assert.ok(lastReq?.headers['if-none-match'] === '"etag-v1"', 'must send if-none-match header');
  } finally {
    await fixture.close();
  }
});

test('CratesIoAdapter respects rate-limit 429 with retry', async () => {
  const fixture = await startFixtureServer([{
    method: 'GET',
    path: '/api/v1/crates/serde',
    responses: [
      { status: 429, headers: { 'retry-after': '0' } },
      { body: FIXTURE_CRATE_SERDE }
    ]
  }]);
  try {
    const adapter = new CratesIoAdapter({
      baseUrl: fixture.url,
      timeoutMs: 5000,
      operationTimeoutMs: 10000,
      maxAttempts: 2,
      concurrency: 4
    });
    const result = await adapter.getCrate('serde');
    assert.equal(result.kind, 'value');
    assert.equal(fixture.requests.length, 2, 'must retry after 429');
  } finally {
    await fixture.close();
  }
});

test('CratesIoAdapter gets crate versions', async () => {
  const fixture = await startFixtureServer([{
    method: 'GET',
    path: '/api/v1/crates/serde/versions',
    responses: [{ body: FIXTURE_VERSIONS_SERDE }]
  }]);
  try {
    const adapter = new CratesIoAdapter({
      baseUrl: fixture.url,
      timeoutMs: 5000,
      operationTimeoutMs: 10000,
      maxAttempts: 1,
      concurrency: 4
    });
    const result = await adapter.getCrateVersions('serde');
    assert.equal(result.kind, 'value');
    if (result.kind === 'value') {
      assert.equal(result.value.versions.length, 2);
      assert.equal(result.value.versions[0]?.num, '1.0.219');
    }
  } finally {
    await fixture.close();
  }
});

test('CratesIoAdapter preserves upstream rate-limit headers', async () => {
  const fixture = await startFixtureServer([{
    method: 'GET',
    path: '/api/v1/crates/serde',
    responses: [
      { status: 429, headers: { 'retry-after': '60' } },
      { status: 429, headers: { 'retry-after': '60' } },
      { status: 429, headers: { 'retry-after': '60' } }
    ]
  }]);
  try {
    const adapter = new CratesIoAdapter({
      baseUrl: fixture.url,
      timeoutMs: 5000,
      operationTimeoutMs: 10000,
      maxAttempts: 3,
      concurrency: 4
    });
    const { UpstreamError, isUpstreamError } = await import('@xregistry/registry-core');
    await assert.rejects(
      adapter.getCrate('serde'),
      (error: unknown) => {
        assert.ok(isUpstreamError(error));
        const err = error as InstanceType<typeof UpstreamError>;
        assert.equal(err.code, 'rate_limited');
        assert.ok(err.retryAfterMs !== undefined && err.retryAfterMs >= 60_000);
        return true;
      }
    );
  } finally {
    await fixture.close();
  }
});
