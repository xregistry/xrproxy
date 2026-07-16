import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { createMatrix, loadManifest, selectServices, validateManifest } from './service-manifest.mjs';
import { expectedValues } from './helm-services.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

test('values.yaml generated section matches config/services.json', () => {
  const valuesPath = resolve(root, 'charts', 'xrproxy', 'values.yaml');
  const current = readFileSync(valuesPath, 'utf8');
  const normalize = (s) => s.replace(/\r\n/g, '\n');
  assert.equal(
    normalize(current),
    normalize(expectedValues(current)),
    'charts/xrproxy/values.yaml is out of date; run: npm run helm:services:generate',
  );
});

test('checkin-validation.yml path triggers cover all active service directories', () => {
  const manifest = validateManifest(loadManifest());
  const active = selectServices(manifest, { status: 'active' });
  const workflow = readFileSync(
    resolve(root, '.github', 'workflows', 'checkin-validation.yml'),
    'utf8',
  );

  const missing = active
    .map(s => s.directory)
    .filter(dir => !workflow.includes(`"${dir}/**"`));

  assert.deepEqual(
    missing,
    [],
    `checkin-validation.yml is missing path triggers for: ${missing.join(', ')}`,
  );
});

test('build-images.yml path triggers cover all active service directories (no exemptions)', () => {
  const manifest = validateManifest(loadManifest());
  const active = selectServices(manifest, { status: 'active' });
  const workflow = readFileSync(
    resolve(root, '.github', 'workflows', 'build-images.yml'),
    'utf8',
  );

  // No exemptions: every active service directory must appear regardless of
  // where its Dockerfile is located.
  const missing = active
    .map(s => s.directory)
    .filter(dir => !workflow.includes(`"${dir}/**"`));

  assert.deepEqual(
    missing,
    [],
    `build-images.yml is missing path triggers for: ${missing.join(', ')}`,
  );
});

// Regression: removing a directory trigger from build-images.yml must cause
// the drift check to fail for that service.
test('drift check detects a missing build-images.yml directory trigger', () => {
  const manifest = validateManifest(loadManifest());
  const active = selectServices(manifest, { status: 'active' });
  const originalWorkflow = readFileSync(
    resolve(root, '.github', 'workflows', 'build-images.yml'),
    'utf8',
  );

  // Normalize to LF so the replacement works identically on Windows and Linux.
  const normalized = originalWorkflow.replace(/\r\n/g, '\n');

  // Excise the first active service's directory trigger from the workflow text.
  const victim = active[0];
  const stripped = normalized.replace(`      - "${victim.directory}/**"\n`, '');

  // The stripped string must actually be shorter (the pattern was present).
  assert.notEqual(
    stripped,
    normalized,
    `"${victim.directory}/**" was not found in build-images.yml — test is invalid`,
  );

  // Simulate the drift-check logic against the mutated workflow text.
  const missingInStripped = active
    .map(s => s.directory)
    .filter(dir => !stripped.includes(`"${dir}/**"`));

  assert.ok(
    missingInStripped.includes(victim.directory),
    `Expected drift check to detect missing "${victim.directory}/**" but it did not`,
  );
});

test('every active proxy service has a matching docker-test matrix entry', () => {
  const manifest = validateManifest(loadManifest());
  const active = selectServices(manifest, { status: 'active', role: 'proxy' });
  const matrix = createMatrix(manifest, 'docker-tests');
  const matrixIds = matrix.map(entry => entry.service);
  const activeIds = active.map(s => s.id);
  assert.deepEqual(matrixIds, activeIds);
});

test('every active service has a matching image matrix entry', () => {
  const manifest = validateManifest(loadManifest());
  const active = selectServices(manifest, { status: 'active' });
  const images = createMatrix(manifest, 'images');
  const imageServiceIds = [...new Set(images.map(entry => entry.service))];
  const activeIds = active.map(s => s.id);
  assert.deepEqual(imageServiceIds, activeIds);
});

