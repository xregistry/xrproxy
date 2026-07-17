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

test('active proxy services include first-wave additions and use unique ports', () => {
  const manifest = validateManifest(loadManifest());
  const proxies = selectServices(manifest, { status: 'active', role: 'proxy' });
  assert.deepEqual(
    proxies.map(service => service.id),
    ['npm', 'pypi', 'maven', 'nuget', 'oci', 'mcp', 'crates', 'rubygems', 'packagist', 'huggingface', 'gomod']
  );
  assert.equal(new Set(proxies.map(service => service.port)).size, proxies.length);
});

test('planned first-wave services have reserved ports and group types', () => {
  const manifest = validateManifest(loadManifest());
  const planned = selectServices(manifest, { status: 'planned', role: 'proxy' });
  assert.deepEqual(
    planned.map(service => service.id),
    ['terraform', 'pubdev']
  );
  assert.equal(new Set(planned.flatMap(service => service.groupTypes)).size, 2);
});

test('image and Docker test matrices are derived from active services', () => {
  const manifest = validateManifest(loadManifest());
  const images = createMatrix(manifest, 'images');
  const dockerTests = createMatrix(manifest, 'docker-tests');

  assert.equal(images.length, 13); // 11 active proxies + bridge + bridge-viewer
  assert.ok(images.some(image => image.image === 'bridge-viewer'));
  assert.ok(images.some(image => image.image === 'huggingface'));
  assert.ok(images.some(image => image.image === 'gomod'));
  assert.ok(images.some(image => image.image === 'rubygems'));
  assert.ok(images.some(image => image.image === 'packagist'));
  assert.deepEqual(
    dockerTests.map(entry => entry.service),
    ['npm', 'pypi', 'maven', 'nuget', 'oci', 'mcp', 'crates', 'rubygems', 'packagist', 'huggingface', 'gomod']
  );
});

test('crates, huggingface, gomod, rubygems, and packagist are all active with distinct ports', () => {
  const manifest = validateManifest(loadManifest());
  const proxies = selectServices(manifest, { status: 'active', role: 'proxy' });
  const ids = proxies.map(s => s.id);
  assert.ok(ids.includes('crates'), 'crates must be active');
  assert.ok(ids.includes('huggingface'), 'huggingface must be active');
  assert.ok(ids.includes('gomod'), 'gomod must be active');
  assert.ok(ids.includes('rubygems'), 'rubygems must be active');
  assert.ok(ids.includes('packagist'), 'packagist must be active');
  // Distinct ports: no two services share a port
  const ports = proxies.map(s => s.port);
  assert.equal(new Set(ports).size, ports.length, 'all active proxy ports must be unique');
});

test('bridge readiness is stricter than liveness', () => {
  const manifest = validateManifest(loadManifest());
  const bridge = manifest.services.find(service => service.id === 'bridge');
  assert.equal(bridge.deployment.healthPath, '/health');
  assert.equal(bridge.deployment.readinessPath, '/ready');
});
