import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createMatrix,
  loadManifest,
  selectServices,
  validateManifest
} from './service-manifest.mjs';

test('the committed service manifest is valid', () => {
  const manifest = validateManifest(loadManifest());
  assert.equal(manifest.schemaVersion, 1);
});

test('active proxy services include MCP and use unique ports', () => {
  const manifest = validateManifest(loadManifest());
  const proxies = selectServices(manifest, { status: 'active', role: 'proxy' });
  assert.deepEqual(
    proxies.map(service => service.id),
    ['npm', 'pypi', 'maven', 'nuget', 'oci', 'mcp']
  );
  assert.equal(new Set(proxies.map(service => service.port)).size, proxies.length);
});

test('planned first-wave services have reserved ports and group types', () => {
  const manifest = validateManifest(loadManifest());
  const planned = selectServices(manifest, { status: 'planned', role: 'proxy' });
  assert.deepEqual(
    planned.map(service => service.id),
    ['crates', 'terraform', 'gomod', 'rubygems', 'packagist', 'pubdev', 'huggingface']
  );
  assert.equal(new Set(planned.flatMap(service => service.groupTypes)).size, 7);
});

test('image and Docker test matrices are derived from active services', () => {
  const manifest = validateManifest(loadManifest());
  const images = createMatrix(manifest, 'images');
  const dockerTests = createMatrix(manifest, 'docker-tests');

  assert.equal(images.length, 8);
  assert.ok(images.some(image => image.image === 'bridge-viewer'));
  assert.deepEqual(
    dockerTests.map(entry => entry.service),
    ['npm', 'pypi', 'maven', 'nuget', 'oci', 'mcp']
  );
});
