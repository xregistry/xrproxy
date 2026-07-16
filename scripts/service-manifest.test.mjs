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

test('active proxy services include MCP and crates, and use unique ports', () => {
  const manifest = validateManifest(loadManifest());
  const proxies = selectServices(manifest, { status: 'active', role: 'proxy' });
  assert.deepEqual(
    proxies.map(service => service.id),
    ['npm', 'pypi', 'maven', 'nuget', 'oci', 'mcp', 'crates']
  );
  assert.equal(new Set(proxies.map(service => service.port)).size, proxies.length);
});

test('planned first-wave services have reserved ports and group types', () => {
  const manifest = validateManifest(loadManifest());
  const planned = selectServices(manifest, { status: 'planned', role: 'proxy' });
  assert.deepEqual(
    planned.map(service => service.id),
    ['terraform', 'gomod', 'rubygems', 'packagist', 'pubdev', 'huggingface']
  );
  assert.equal(new Set(planned.flatMap(service => service.groupTypes)).size, 6);
});

test('image and Docker test matrices are derived from active services', () => {
  const manifest = validateManifest(loadManifest());
  const images = createMatrix(manifest, 'images');
  const dockerTests = createMatrix(manifest, 'docker-tests');

  assert.equal(images.length, 9); // npm, pypi, maven, nuget, oci, mcp, crates, bridge, bridge-viewer
  assert.ok(images.some(image => image.image === 'bridge-viewer'));
  assert.deepEqual(
    dockerTests.map(entry => entry.service),
    ['npm', 'pypi', 'maven', 'nuget', 'oci', 'mcp', 'crates']
  );
});

test('bridge readiness is stricter than liveness', () => {
  const manifest = validateManifest(loadManifest());
  const bridge = manifest.services.find(service => service.id === 'bridge');
  assert.equal(bridge.deployment.healthPath, '/health');
  assert.equal(bridge.deployment.readinessPath, '/ready');
});
