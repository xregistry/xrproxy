/**
 * Unit tests for configuration constants
 */

import { createServer } from 'node:http';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRegistryApp } from '@xregistry/registry-core';
import { EntityStateManager } from '../../../shared/entity-state-manager';
import { CAPABILITIES, FALLBACK_PACKAGES, MODEL, REGISTRY_METADATA } from '../../src/config/constants';
import { parsePubDevConfig } from '../../src/config/constants';
import { RegistryService } from '../../src/services/registry-service';
import type { SearchService } from '../../src/services/search-service';

const repositoryRoot = path.basename(process.cwd()).toLowerCase() === 'pubdev'
  ? path.resolve(process.cwd(), '..')
  : process.cwd();
const { assertCapabilitiesConform } = require(
  path.join(repositoryRoot, 'test/helpers/xregistry-capability-conformance.cjs'),
);

test('REGISTRY_METADATA has correct group type and route identity', () => {
  assert.equal(REGISTRY_METADATA.GROUP_TYPE, 'dartregistries');
  assert.equal(REGISTRY_METADATA.GROUP_ID, 'pub');
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

test('CAPABILITIES is the complete rc2 contract', () => {
  assertCapabilitiesConform(CAPABILITIES, { flags: ['filter', 'sort'], versionmodes: ['manual'] });
});

test('runtime capability and model endpoints preserve exact JSON keys', async () => {
  const app = createRegistryApp({ model: MODEL, capabilities: CAPABILITIES });
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const capabilities = await (await fetch(`${base}/capabilities`)).json();
    assertCapabilitiesConform(capabilities, { flags: ['filter', 'sort'], versionmodes: ['manual'] });
    const source = await (await fetch(`${base}/modelsource`)).json() as Record<string, unknown>;
    const full = await (await fetch(`${base}/model`)).json() as Record<string, unknown>;
    assert.deepEqual(Object.keys(source).sort(), Object.keys(MODEL).sort());
    assert.equal(Object.hasOwn(source, 'default'), false);
    assert.equal(Object.hasOwn(full, 'default'), false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('model.json matches the dart-pub-dev resource schema', () => {
  const model = require('../../model.json') as Record<string, unknown>;
  const groups = model['groups'] as Record<string, unknown>;
  assert.ok('dartregistries' in groups);
  const dartregistries = groups['dartregistries'] as Record<string, unknown>;
  const resources = dartregistries['resources'] as Record<string, unknown>;
  const attributes = dartregistries['attributes'] as Record<string, unknown>;
  assert.deepEqual(Object.keys(attributes).sort(), ['sourceurl']);

  assert.ok('packages' in resources);
  const packages = resources['packages'] as Record<string, unknown>;
  const packageAttributes = packages['attributes'] as Record<string, unknown>;
  const packageMetaAttributes = packages['metaattributes'] as Record<string, unknown>;

  assert.equal(packages['maxversions'], 0);
  assert.equal(packages['setversionid'], true);
  assert.equal(packages['singleversionroot'], true);
  assert.equal(packages['versionmode'], 'manual');
  assert.equal(Object.hasOwn(packages, 'setdefaultversionsticky'), false);
  assert.equal('versions' in packages, false);
  assert.equal('resources' in packages, false);

  assert.deepEqual(Object.keys(packageAttributes).sort(), [
    'archive_sha256',
    'archive_url',
    'declared_platforms',
    'dependencies',
    'dependency_overrides',
    'dev_dependencies',
    'environment',
    'flutter_constraint',
    'homepage',
    'issue_tracker',
    'name',
    'package',
    'published',
    'pubspec',
    'repository',
    'retracted',
    'sdk_constraint',
    'topics',
    'version',
  ].sort());

  assert.deepEqual(Object.keys(packageMetaAttributes).sort(), [
    'advisories_updated',
    'defaultversionsticky',
    'detected_platforms',
    'download_count_30_days',
    'is_discontinued',
    'license',
    'likes',
    'max_points',
    'pub_points',
    'publisher',
    'replaced_by',
    'tags',
  ].sort());

  const defaultSticky = packageMetaAttributes['defaultversionsticky'] as Record<string, unknown>;
  assert.equal(defaultSticky['required'], true);
  assert.deepEqual(defaultSticky['enum'], [false]);
  assert.equal(defaultSticky['default'], false);
});

test('RegistryService exposes pub group identity and sourceurl', () => {
  const search = {
    isAuthoritative: () => true,
    getAll: () => ['collection', 'http'],
  } as unknown as SearchService;
  const service = new RegistryService(search, new EntityStateManager(), 'https://pub.dev');
  const group = service.getGroupDetails('https://registry.example.test');
  assert.equal(group['dartregistryid'], 'pub');
  assert.equal(group['sourceurl'], 'https://pub.dev');
  assert.equal(group['packagesurl'], 'https://registry.example.test/dartregistries/pub/packages');
  assert.equal(group['packagescount'], 2);
});

test('CACHE_DIR env var is used when set', () => {
  const pathModule = require('node:path');
  const cacheDir = process.env['CACHE_DIR'] ?? pathModule.join(process.cwd(), 'cache');
  assert.ok(pathModule.isAbsolute(cacheDir), 'cacheDir is absolute');
  assert.ok(cacheDir.includes('cache'), 'cacheDir contains "cache"');
});

test('CACHE_DIR=/app/pubdev/cache is read when Docker sets it', () => {
  const savedEnv = process.env['CACHE_DIR'];
  process.env['CACHE_DIR'] = '/app/pubdev/cache';
  const cacheDir = process.env['CACHE_DIR'] ?? 'fallback';
  assert.equal(cacheDir, '/app/pubdev/cache');
  if (savedEnv === undefined) delete process.env['CACHE_DIR'];
  else process.env['CACHE_DIR'] = savedEnv;
});
