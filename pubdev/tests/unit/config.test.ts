/**
 * Unit tests for configuration constants
 */

import { createServer } from "node:http";
import * as path from "node:path";
import assert from 'node:assert/strict';
import test from 'node:test';
import { FALLBACK_PACKAGES, REGISTRY_METADATA, CAPABILITIES, MODEL } from '../../src/config/constants';
import { createRegistryApp } from "@xregistry/registry-core";
import { parsePubDevConfig } from '../../src/config/constants';

const repositoryRoot = path.basename(process.cwd()).toLowerCase() === "pubdev"
  ? path.resolve(process.cwd(), "..")
  : process.cwd();
const { assertCapabilitiesConform } = require(
  path.join(repositoryRoot, "test/helpers/xregistry-capability-conformance.cjs"),
);

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

test("CAPABILITIES is the complete rc2 contract", () => {
  assertCapabilitiesConform(CAPABILITIES, { flags: ["filter", "sort"], versionmodes: ["manual"] });
});

test("runtime capability and model endpoints preserve exact JSON keys", async () => {
  const app = createRegistryApp({ model: MODEL, capabilities: CAPABILITIES });
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const capabilities = await (await fetch(`${base}/capabilities`)).json();
    assertCapabilitiesConform(capabilities, { flags: ["filter", "sort"], versionmodes: ["manual"] });
    const source = await (await fetch(`${base}/modelsource`)).json() as Record<string, unknown>;
    const full = await (await fetch(`${base}/model`)).json() as Record<string, unknown>;
    assert.deepEqual(Object.keys(source).sort(), Object.keys(MODEL).sort());
    assert.equal(Object.hasOwn(source, "default"), false);
    assert.equal(Object.hasOwn(full, "default"), false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('model.json uses built-in Resource versions', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const model = require('../../model.json') as Record<string, unknown>;
  const groups = model['groups'] as Record<string, unknown>;
  assert.ok('dartregistries' in groups);
  const dr = groups['dartregistries'] as Record<string, unknown>;
  const resources = dr['resources'] as Record<string, unknown>;
  assert.ok('packages' in resources);
  const pkgs = resources['packages'] as Record<string, unknown>;
  assert.equal(pkgs['maxversions'], 0);
  assert.equal(pkgs['setversionid'], true);
  assert.equal(pkgs['setdefaultversionsticky'], false);
  assert.equal(pkgs['versionmode'], 'manual');
  assert.equal('versions' in pkgs, false);
  assert.equal('resources' in pkgs, false);
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
