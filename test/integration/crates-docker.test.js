'use strict';

/**
 * Crates.io Docker Integration Tests
 * Runs the crates proxy in Docker (FIXTURE_MODE=true) and validates xRegistry endpoints.
 */

const assert = require('node:assert/strict');
const { execSync, spawn } = require('node:child_process');
const { setTimeout: sleep } = require('node:timers/promises');

const PORT = process.env.CRATES_TEST_PORT ?? '37001';
const BASE_URL = `http://localhost:${PORT}`;
const CONTAINER_NAME = `xrproxy-crates-test-${Date.now()}`;
const IMAGE_NAME = `xrproxy-crates-test-image-${Date.now()}`;

async function waitForHealth(maxAttempts = 20, delayMs = 1000) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) return true;
    } catch {
      // not ready yet
    }
    await sleep(delayMs);
  }
  return false;
}

async function get(path) {
  const res = await fetch(`${BASE_URL}${path}`, { signal: AbortSignal.timeout(5000) });
  return { status: res.status, body: await res.json() };
}

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

test('health endpoint returns ok', async () => {
  const { status, body } = await get('/health');
  assert.equal(status, 200);
  assert.equal(body.status, 'ok');
});

test('ready endpoint returns ready', async () => {
  const { status, body } = await get('/ready');
  assert.equal(status, 200);
  assert.equal(body.status, 'ready');
});

test('model endpoint returns rustregistries group', async () => {
  const { status, body } = await get('/model');
  assert.equal(status, 200);
  assert.ok(body.groups?.rustregistries, 'rustregistries group required in model');
});

test('capabilities endpoint returns schemas', async () => {
  const { status, body } = await get('/capabilities');
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.schemas));
});

test('registry root returns registryid crates.io', async () => {
  const { status, body } = await get('/');
  assert.equal(status, 200);
  assert.equal(body.registryid, 'crates.io');
  assert.ok(typeof body.rustregistriesurl === 'string');
});

test('rustregistries collection includes crates.io', async () => {
  const { status, body } = await get('/rustregistries');
  assert.equal(status, 200);
  assert.ok(body['crates.io'], 'crates.io must be present');
});

test('rustregistries/crates.io group has cratesurl', async () => {
  const { status, body } = await get('/rustregistries/crates.io');
  assert.equal(status, 200);
  assert.ok(typeof body.cratesurl === 'string');
});

test('unknown registry returns 404', async () => {
  const { status } = await get('/rustregistries/unknown-registry');
  assert.equal(status, 404);
});

test('crates list returns fixture crates', async () => {
  const { status, body } = await get('/rustregistries/crates.io/crates');
  assert.equal(status, 200);
  assert.ok(body.serde, 'serde must be in fixture list');
  assert.ok(body.tokio, 'tokio must be in fixture list');
});

test('serde crate detail returns xRegistry fields', async () => {
  const { status, body } = await get('/rustregistries/crates.io/crates/serde');
  assert.equal(status, 200);
  assert.equal(body.crateid, 'serde');
  assert.ok(typeof body.versionsurl === 'string');
  assert.ok(typeof body.max_version === 'string');
});

test('unknown crate returns 404', async () => {
  const { status } = await get('/rustregistries/crates.io/crates/this-crate-does-not-exist-xyz');
  assert.equal(status, 404);
});

test('serde versions list has 1.0.219', async () => {
  const { status, body } = await get('/rustregistries/crates.io/crates/serde/versions');
  assert.equal(status, 200);
  assert.ok(body['1.0.219'], '1.0.219 must be present');
  const v = body['1.0.219'];
  assert.equal(v.immutable, true, 'version must be immutable');
});

test('serde 1.0.219 version detail', async () => {
  const { status, body } = await get('/rustregistries/crates.io/crates/serde/versions/1.0.219');
  assert.equal(status, 200);
  assert.equal(body.versionid, '1.0.219');
  assert.equal(body.immutable, true);
});

test('unknown version returns 404', async () => {
  const { status } = await get('/rustregistries/crates.io/crates/serde/versions/0.0.0');
  assert.equal(status, 404);
});

async function main() {
  const dockerAvailable = (() => {
    try { execSync('docker info --format "{{.ServerVersion}}"', { stdio: 'ignore' }); return true; }
    catch { return false; }
  })();

  if (!dockerAvailable) {
    console.log('SKIP: Docker not available — skipping Docker integration tests');
    process.exit(0);
  }

  const rootDir = require('node:path').resolve(__dirname, '../..');
  console.log(`Building Docker image ${IMAGE_NAME} from ${rootDir} ...`);
  try {
    execSync(`docker build -f crates.Dockerfile -t ${IMAGE_NAME} .`, {
      cwd: rootDir,
      stdio: 'inherit'
    });
  } catch (err) {
    console.error('Docker build failed:', err.message);
    process.exit(1);
  }

  const container = spawn('docker', [
    'run', '--rm', '--name', CONTAINER_NAME,
    '-p', `${PORT}:3700`,
    '-e', 'FIXTURE_MODE=true',
    '-e', `PORT=3700`,
    IMAGE_NAME
  ], { stdio: 'inherit' });

  let passed = 0;
  let failed = 0;

  try {
    console.log(`Waiting for server at ${BASE_URL} ...`);
    const ready = await waitForHealth(30, 1000);
    if (!ready) {
      console.error('Server did not become healthy in time');
      process.exit(1);
    }

    for (const { name, fn } of tests) {
      try {
        await fn();
        console.log(`  ✔ ${name}`);
        passed++;
      } catch (err) {
        console.error(`  ✘ ${name}`);
        console.error(`    ${err.message}`);
        failed++;
      }
    }
  } finally {
    try { execSync(`docker stop ${CONTAINER_NAME}`, { stdio: 'ignore' }); } catch { /* ignore */ }
    try { execSync(`docker rmi ${IMAGE_NAME}`, { stdio: 'ignore' }); } catch { /* ignore */ }
    container.kill();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
