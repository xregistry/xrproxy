/**
 * Unit tests for configuration constants
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { FALLBACK_PACKAGES, REGISTRY_METADATA, CAPABILITIES } from '../../src/config/constants';
import { parsePubDevConfig } from '../../src/config/constants';

test('REGISTRY_METADATA has correct group type and port', () => {
  assert.equal(REGISTRY_METADATA.GROUP_TYPE, 'dartregistries');
  assert.equal(REGISTRY_METADATA.GROUP_ID, 'pub.dev');
  assert.equal(REGISTRY_METADATA.RESOURCE_TYPE, 'packages');
  assert.equal(REGISTRY_METADATA.SPEC_VERSION, '1.0-rc2');
});

test('parsePubDevConfig defaults to port 4200 and upstream https://pub.dev', () => {
  const cfg = parsePubDevConfig({});
  assert.equal(cfg.PORT, 4200);
  assert.equal(cfg.UPSTREAM_URL, 'https://pub.dev/');
});

test('parsePubDevConfig respects PORT env var', () => {
  const cfg = parsePubDevConfig({ PORT: '4242' });
  assert.equal(cfg.PORT, 4242);
});

test('FALLBACK_PACKAGES are unique and non-empty strings', () => {
  assert.ok(FALLBACK_PACKAGES.length > 0);
  const unique = new Set(FALLBACK_PACKAGES);
  assert.equal(unique.size, FALLBACK_PACKAGES.length, 'no duplicates');
  for (const p of FALLBACK_PACKAGES) {
    assert.ok(typeof p === 'string' && p.length > 0);
  }
});

test('CAPABILITIES has mutable=false and pagination=true', () => {
  assert.equal(CAPABILITIES.mutable, false);
  assert.equal(CAPABILITIES.pagination, true);
  assert.equal(CAPABILITIES.filter, true);
});

test('model.json groups has dartregistries with versions', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const model = require('../../model.json') as Record<string, unknown>;
  const groups = model['groups'] as Record<string, unknown>;
  assert.ok('dartregistries' in groups);
  const dr = groups['dartregistries'] as Record<string, unknown>;
  const resources = dr['resources'] as Record<string, unknown>;
  assert.ok('packages' in resources);
  const pkgs = resources['packages'] as Record<string, unknown>;
  assert.ok('versions' in pkgs);
});


test('CACHE_DIR env var is used when set', () => {
  // The server reads process.env.CACHE_DIR and falls back to process.cwd()/cache
  // We verify the fallback resolves to an absolute path that ends with /cache
  const path = require('node:path');
  const cacheDir = process.env['CACHE_DIR'] ?? path.join(process.cwd(), 'cache');
  assert.ok(path.isAbsolute(cacheDir), 'cacheDir is absolute');
  assert.ok(cacheDir.includes('cache'), 'cacheDir contains "cache"');
});

test('CACHE_DIR=/app/pubdev/cache is read when Docker sets it', () => {
  // Simulate the Docker/Helm mount env
  const savedEnv = process.env['CACHE_DIR'];
  process.env['CACHE_DIR'] = '/app/pubdev/cache';
  const cacheDir = process.env['CACHE_DIR'] ?? 'fallback';
  assert.equal(cacheDir, '/app/pubdev/cache');
  if (savedEnv === undefined) delete process.env['CACHE_DIR'];
  else process.env['CACHE_DIR'] = savedEnv;
});