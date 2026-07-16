import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCratesConfig, cratesConfigSchema } from '../../src/config';

test('parseCratesConfig defaults', () => {
  const config = parseCratesConfig({});
  assert.equal(config.HOST, '0.0.0.0');
  assert.equal(config.PORT, 3700);
  assert.equal(config.UPSTREAM_URL, 'https://crates.io/');
  assert.equal(config.FIXTURE_MODE, false);
  assert.equal(config.CACHE_DIR, './cache');
  assert.equal(config.CACHE_TTL_MS, 300_000);
  assert.equal(config.CACHE_NEGATIVE_TTL_MS, 30_000);
  assert.equal(config.CACHE_STALE_IF_ERROR_MS, 900_000);
  assert.equal(config.UPSTREAM_TIMEOUT_MS, 10_000);
  assert.equal(config.UPSTREAM_MAX_ATTEMPTS, 3);
});

test('parseCratesConfig overrides from environment', () => {
  const config = parseCratesConfig({
    PORT: '3701',
    UPSTREAM_URL: 'http://localhost:9999',
    FIXTURE_MODE: 'true',
    CACHE_DIR: '/tmp/crates-cache',
    CACHE_TTL_MS: '60000'
  });
  assert.equal(config.PORT, 3701);
  assert.equal(config.UPSTREAM_URL, 'http://localhost:9999/');
  assert.equal(config.FIXTURE_MODE, true);
  assert.equal(config.CACHE_DIR, '/tmp/crates-cache');
  assert.equal(config.CACHE_TTL_MS, 60_000);
});

test('parseCratesConfig rejects invalid port', () => {
  assert.throws(() => parseCratesConfig({ PORT: '99999' }), /PORT must be at most 65535/);
  assert.throws(() => parseCratesConfig({ PORT: '0' }), /PORT must be at least 1/);
  assert.throws(() => parseCratesConfig({ PORT: 'abc' }), /PORT must be an integer/);
});

test('parseCratesConfig rejects invalid URL protocol', () => {
  assert.throws(() => parseCratesConfig({ UPSTREAM_URL: 'ftp://crates.io' }), /UPSTREAM_URL must use one of/);
});

test('cratesConfigSchema has rustregistries port', () => {
  const schema = cratesConfigSchema;
  assert.ok(schema.PORT);
  if (schema.PORT.type === 'integer') {
    assert.equal(schema.PORT.default, 3700);
  }
});
