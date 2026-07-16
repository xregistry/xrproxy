#!/usr/bin/env node
/**
 * CI drift check — verifies that workflow path-trigger globs and generated
 * artifacts stay in sync with config/services.json.
 *
 * Checks performed:
 *   1. charts/xrproxy/values.yaml generated section matches services.json
 *      (same check as `npm run helm:services:check`; run here so the gate job
 *       reports a dedicated drift failure rather than a matrix-setup failure).
 *   2. .github/workflows/checkin-validation.yml push/PR path triggers include
 *      every active service directory.
 *   3. .github/workflows/build-images.yml push/PR path triggers include every
 *      active service directory unconditionally — source files in <dir>/ are
 *      the authoritative trigger for an image rebuild, regardless of where the
 *      Dockerfile lives.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadManifest, selectServices, validateManifest } from './service-manifest.mjs';
import { expectedValues } from './helm-services.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

function readWorkflow(name) {
  return readFileSync(resolve(root, '.github', 'workflows', name), 'utf8');
}

/** Collect all drift errors; fail at the end so every issue is surfaced. */
const errors = [];

function check(condition, message) {
  if (!condition) errors.push(message);
}

const manifest = validateManifest(loadManifest());
const active = selectServices(manifest, { status: 'active' });

// ── 1. Helm values.yaml drift ────────────────────────────────────────────────
// Normalize line endings before comparison to avoid CRLF vs LF false-positives
// on Windows (git may check out files with CRLF while renderHelmServices()
// generates LF-only content).
const normalize = (s) => s.replace(/\r\n/g, '\n');

const valuesPath = resolve(root, 'charts', 'xrproxy', 'values.yaml');
const currentValues = readFileSync(valuesPath, 'utf8');
const expected = expectedValues(currentValues);
check(
  normalize(currentValues) === normalize(expected),
  'charts/xrproxy/values.yaml generated section is out of date with ' +
    'config/services.json — run: npm run helm:services:generate',
);

// ── 2. checkin-validation.yml path-trigger coverage ─────────────────────────
const checkinYml = readWorkflow('checkin-validation.yml');

for (const service of active) {
  const dir = service.directory;
  const pattern = `"${dir}/**"`;
  check(
    checkinYml.includes(pattern),
    `checkin-validation.yml push/PR path triggers are missing "${dir}/**" ` +
      `(service "${service.id}"); add it or the workflow will not run when ` +
      `${dir}/ changes`,
  );
}

// ── 3. build-images.yml path-trigger coverage ────────────────────────────────
// Every active service directory must appear as a path trigger in
// build-images.yml, regardless of where its Dockerfile lives.  Source files
// in <directory>/ are the canonical trigger for an image rebuild; relying on
// "*.Dockerfile" alone would miss changes to TypeScript source.
const buildYml = readWorkflow('build-images.yml');

for (const service of active) {
  const dir = service.directory;
  const pattern = `"${dir}/**"`;
  check(
    buildYml.includes(pattern),
    `build-images.yml push/PR path triggers are missing "${dir}/**" ` +
      `(service "${service.id}") — add it so source changes to ${dir}/ ` +
      `always trigger an image rebuild`,
  );
}

// ── Report ───────────────────────────────────────────────────────────────────
if (errors.length > 0) {
  for (const error of errors) {
    console.error(`CI drift: ${error}`);
  }
  console.error(`\n${errors.length} drift error(s) found.`);
  process.exit(1);
}

console.log(
  `CI drift check passed — ${active.length} active service(s), ` +
    `values.yaml in sync, workflow path triggers complete.`,
);
