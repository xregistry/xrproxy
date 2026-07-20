/**
 * pub.dev Docker Integration Tests
 *
 * Deterministic: the Docker container is started with UPSTREAM_URL pointing
 * to a local fixture server, so no live pub.dev connection is required.
 * Tests MUST pass when pub.dev is unreachable.
 */

const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { exec } = require('node:child_process');
const path = require('node:path');
const { promisify } = require('node:util');

const execAsync = promisify(exec);
const { assertCapabilitiesConform } = require("../helpers/xregistry-capability-conformance.cjs");

// ── Minimal fixture server (no external deps) ─────────────────────────────

const PACKAGE_BODY = JSON.stringify({
  name: 'http',
  latest: {
    version: '1.2.0',
    pubspec: {
      name: 'http',
      version: '1.2.0',
      description: 'A composable HTTP library.',
      environment: { sdk: '^3.0.0' },
    },
    archive_url: 'https://pub.dev/api/archives/http-1.2.0.tar.gz',
    archive_sha256: 'deadbeef01234567',
    published: '2024-01-01T00:00:00.000Z',
  },
  versions: [
    {
      version: '0.9.0',
      pubspec: { name: 'http', version: '0.9.0' },
      archive_url: 'https://pub.dev/api/archives/http-0.9.0.tar.gz',
      archive_sha256: 'sha000',
      published: '2020-01-01T00:00:00.000Z',
    },
    {
      version: '1.0.0-beta.1',
      pubspec: { name: 'http', version: '1.0.0-beta.1' },
      archive_url: 'https://pub.dev/api/archives/http-1.0.0-beta.1.tar.gz',
      archive_sha256: 'sha_beta',
      published: '2022-06-01T00:00:00.000Z',
    },
    {
      version: '1.1.0+build.1',
      pubspec: { name: 'http', version: '1.1.0+build.1' },
      archive_url: 'https://pub.dev/api/archives/http-1.1.0+build.1.tar.gz',
      archive_sha256: 'sha_build',
      published: '2023-01-01T00:00:00.000Z',
    },
    {
      version: '1.2.0',
      pubspec: { name: 'http', version: '1.2.0', description: 'A composable HTTP library.', environment: { sdk: '^3.0.0' } },
      archive_url: 'https://pub.dev/api/archives/http-1.2.0.tar.gz',
      archive_sha256: 'deadbeef01234567',
      published: '2024-01-01T00:00:00.000Z',
    },
  ],
});

const SCORE_BODY = JSON.stringify({
  grantedPoints: 140, maxPoints: 160, likeCount: 5000, popularityScore: 0.98,
});
const PUBLISHER_BODY = JSON.stringify({ publisherId: 'dart.dev' });
const PACKAGE_NAMES = ['async', 'collection', 'http', 'meta', 'path', 'test'];
const NAMES_BODY = JSON.stringify({ packages: PACKAGE_NAMES });

function packageBodyFor(name) {
  const body = JSON.parse(PACKAGE_BODY);
  body.name = name;
  body.latest.pubspec.name = name;
  body.versions = body.versions.map(version => ({
    ...version,
    pubspec: { ...version.pubspec, name },
  }));
  return JSON.stringify(body);
}

function startFixture() {
  const routes = new Map([
    ['GET /api/package-names',              { body: NAMES_BODY }],
    ...PACKAGE_NAMES.map(name => [`GET /api/packages/${name}`, { body: packageBodyFor(name) }]),
    ['GET /api/packages/http/score',        { body: SCORE_BODY }],
    ['GET /api/packages/http/publisher',    { body: PUBLISHER_BODY }],
  ]);
  const server = http.createServer((req, res) => {
    const key = `${req.method} ${new URL(req.url, 'http://fixture').pathname}`;
    const route = routes.get(key);
    if (route) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(route.body);
    } else {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    }
  });
  server.listen(0, '0.0.0.0');
  return new Promise(resolve => server.once('listening', () => resolve(server)));
}

// ── Helpers ───────────────────────────────────────────────────────────────

async function run(cmd, cwd) {
  try {
    const { stdout, stderr } = await execAsync(cmd, cwd ? { cwd } : {});
    if (stderr && !stderr.includes('WARNING') && !stderr.includes('warning')) {
      console.log('STDERR:', stderr.slice(0, 300));
    }
    return { stdout, stderr };
  } catch (err) {
    console.error(`Command failed: ${cmd}`);
    throw err;
  }
}

async function waitForServer(url, retries = 40, delay = 3000) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
      if (res.ok) return true;
    } catch { /* keep waiting */ }
    await new Promise(r => setTimeout(r, delay));
  }
  return false;
}

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  return res.json();
}

// ── Test suite ────────────────────────────────────────────────────────────

describe('pub.dev Docker Integration Tests (deterministic fixtures)', function () {
  this.timeout(300_000);

  let container;
  let port;
  let baseUrl;
  let fixture;
  let fixturePort;
  let hostIp;

  before(async function () {
    this.timeout(180_000);

    // 1. Start fixture server
    fixture = await startFixture();
    fixturePort = fixture.address().port;
    // Use host.docker.internal with the --add-host flag so the container can
    // reach the fixture on both Linux (host-gateway resolves correctly) and
    // Windows/macOS Docker Desktop (where 172.17.0.1 is not routable from
    // inside a container).
    hostIp = 'host.docker.internal';
    const fixtureUrl = `http://${hostIp}:${fixturePort}`;
    console.log(`Fixture URL from container: ${fixtureUrl}`);

    // 2. Build image
    const root = path.resolve(__dirname, '../../');
    container = `pubdev-test-${Date.now()}`;
    port = Math.floor(Math.random() * (65535 - 49152) + 49152);
    baseUrl = `http://localhost:${port}`;

    console.log('Building Docker image...');
    await run(`docker build -f pubdev.Dockerfile -t pubdev-test:latest .`, root);

    // 3. Start container pointing at fixture
    console.log(`Starting container (fixture: ${fixtureUrl})...`);
    await run(
      `docker run -d --name ${container} ` +
      `--add-host=host.docker.internal:host-gateway ` +
      `-p ${port}:4200 ` +
      `-e PORT=4200 -e HOST=0.0.0.0 ` +
      `-e UPSTREAM_URL=${fixtureUrl} ` +
      `-e CACHE_TTL_MS=300000 ` +
      `pubdev-test:latest`
    );

    const ready = await waitForServer(`${baseUrl}/health`);
    if (!ready) {
      const { stdout } = await run(`docker logs ${container}`).catch(() => ({ stdout: '' }));
      console.error('Container logs:\n', stdout);
      throw new Error('Server did not become ready');
    }
    console.log('Server ready');
  });

  after(async function () {
    this.timeout(60_000);
    if (fixture) { fixture.close(); }
    if (container) {
      await run(`docker stop --time=10 ${container}`).catch(() => {});
      await run(`docker rm -f ${container}`).catch(() => {});
    }
    await run('docker rmi pubdev-test:latest').catch(() => {});
  });

  // ── Health & root ──────────────────────────────────────────────────────

  it('GET /health returns status ok', async () => {
    const data = await getJson(`${baseUrl}/health`);
    assert.equal(data.status, 'ok');
  });

  it('GET / returns xRegistry root with dartregistriesurl', async () => {
    const data = await getJson(`${baseUrl}/`);
    assert.equal(data.registryid, 'pubdev-wrapper');
    assert.equal(data.specversion, '1.0-rc2');
    assert.ok('dartregistriesurl' in data, 'dartregistriesurl present');
  });

  it('GET /model has dartregistries group with packages resource', async () => {
    const data = await getJson(`${baseUrl}/model`);
    assert.ok(data.groups?.dartregistries, 'dartregistries group');
    assert.ok(data.groups.dartregistries.resources?.packages, 'packages resource');
    const packages = data.groups.dartregistries.resources.packages;
    assert.equal(packages.maxversions, 0, 'built-in versions enabled');
    assert.equal(packages.versionmode, 'manual', 'opaque build-metadata IDs require manual mode');
    assert.equal('versions' in packages, false, 'no unsupported resource-level versions model');
    assert.equal('resources' in packages, false, 'no nested version resource');
    assert.ok(packages.attributes.versionid, 'full model includes Version fields');
    assert.ok(packages.resourceattributes.versionscount, 'full model includes Resource fields');
    const source = await getJson(`${baseUrl}/modelsource`);
    assert.deepEqual(Object.keys(source), ["description", "groups"]);
    assert.equal(Object.hasOwn(source, "default"), false);
    assert.equal(Object.hasOwn(data, "default"), false);
    assert.equal('resourceattributes' in source.groups.dartregistries.resources.packages, false);
  });

  it("GET /capabilities satisfies the rc2 schema and runtime profile", async () => {
    const data = await getJson(`${baseUrl}/capabilities`);
    assertCapabilitiesConform(data, { flags: ["filter", "sort"], versionmodes: ["manual"] });
  });

  // ── Group endpoints ────────────────────────────────────────────────────

  it('GET /dartregistries returns pub.dev group', async () => {
    const data = await getJson(`${baseUrl}/dartregistries`);
    assert.ok('pub.dev' in data);
  });

  it('GET /dartregistries/pub.dev returns group detail', async () => {
    const data = await getJson(`${baseUrl}/dartregistries/pub.dev`);
    assert.equal(data.dartregistryid, 'pub.dev');
  });

  it('GET /dartregistries/nonexistent returns 404', async () => {
    try {
      await getJson(`${baseUrl}/dartregistries/does-not-exist.registry`);
      assert.fail('should have thrown');
    } catch (err) {
      assert.equal(err.status, 404);
    }
  });

  // ── Package collection ─────────────────────────────────────────────────

  it('GET /dartregistries/pub.dev/packages returns packages from fixture', async () => {
    const data = await getJson(`${baseUrl}/dartregistries/pub.dev/packages`);
    assert.ok(typeof data === 'object');
    const keys = Object.keys(data);
    assert.ok(keys.length > 0, 'at least one package from fixture names list');
    assert.ok(keys.includes('http'), 'http is in fixture names');
  });

  it('GET /dartregistries/pub.dev/packages?limit=2 returns at most 2 items', async () => {
    const data = await getJson(`${baseUrl}/dartregistries/pub.dev/packages?limit=2`);
    assert.ok(Object.keys(data).length <= 2);
  });

  it('GET /dartregistries/pub.dev/packages?limit=0 returns 400', async () => {
    try {
      await getJson(`${baseUrl}/dartregistries/pub.dev/packages?limit=0`);
      assert.fail('should have thrown');
    } catch (err) {
      assert.equal(err.status, 400);
    }
  });

  // ── Package endpoints ──────────────────────────────────────────────────

  it('GET /dartregistries/pub.dev/packages/http returns package from fixture', async () => {
    const data = await getJson(`${baseUrl}/dartregistries/pub.dev/packages/http`);
    assert.equal(data.packageid, 'http');
    assert.equal(data.versionid, '1.2.0');
    assert.equal(Object.hasOwn(data, 'publisher'), false);
    assert.equal(data.versionscount, 4);
    assert.ok(typeof data.ancestor === 'string');
    assert.equal(Object.hasOwn(data, 'likes'), false);
  });

  it('GET /dartregistries/pub.dev/packages/http/meta returns meta', async () => {
    const data = await getJson(`${baseUrl}/dartregistries/pub.dev/packages/http/meta`);
    assert.equal(data.readonly, true);
    assert.equal(data.defaultversionid, '1.2.0');
    assert.equal(data.publisher, 'dart.dev');
    assert.ok(typeof data.likes === 'number');
    assert.equal(Object.hasOwn(data, 'ancestor'), false);
  });

  it('GET .../packages/no-such-package-xyzabc123 returns 404', async () => {
    try {
      await getJson(`${baseUrl}/dartregistries/pub.dev/packages/no-such-package-xyzabc123`);
      assert.fail('should have thrown');
    } catch (err) {
      // Fixture returns 404 for unknown packages; proxy must forward that as 404
      assert.equal(err.status, 404);
    }
  });

  // ── Version endpoints ──────────────────────────────────────────────────

  it('GET .../packages/http/versions returns all versions in deterministic pub.dev order', async () => {
    const data = await getJson(`${baseUrl}/dartregistries/pub.dev/packages/http/versions`);
    const keys = Object.keys(data);
    assert.equal(keys.length, 4);
    const plusId = `xv~${Buffer.from('1.1.0+build.1').toString('base64url')}`;
    assert.ok(keys.includes(plusId), 'build metadata uses an xRegistry-safe ID');
    assert.ok(keys.every(k => /^[A-Za-z0-9_][A-Za-z0-9._~:@-]*$/.test(k)));
    assert.ok(keys.indexOf('1.0.0-beta.1') < keys.indexOf('1.2.0'), 'prerelease before stable');
  });

  it('encoded + version detail retains the raw pub.dev version', async () => {
    const plusId = `xv~${Buffer.from('1.1.0+build.1').toString('base64url')}`;
    const data = await getJson(`${baseUrl}/dartregistries/pub.dev/packages/http/versions/${plusId}`);
    assert.equal(data.versionid, plusId);
    assert.equal(data.version, '1.1.0+build.1');
    assert.equal(data.packageid, 'http');
    assert.ok(typeof data.ancestor === 'string');
  });

  it('version detail has archive_url, archive_sha256, published, isdefault', async () => {
    const data = await getJson(`${baseUrl}/dartregistries/pub.dev/packages/http/versions/1.2.0`);
    assert.equal(data.versionid, '1.2.0');
    assert.ok(data.archive_url.includes('1.2.0'), 'archive_url contains version');
    assert.equal(data.archive_sha256, 'deadbeef01234567');
    assert.equal(data.published, '2024-01-01T00:00:00.000Z');
    assert.equal(data.isdefault, true);
    assert.equal(data.retracted, false);
  });

  it('prerelease version (1.0.0-beta.1) has isdefault=false', async () => {
    const data = await getJson(`${baseUrl}/dartregistries/pub.dev/packages/http/versions/1.0.0-beta.1`);
    assert.equal(data.versionid, '1.0.0-beta.1');
    assert.equal(data.isdefault, false);
  });

  it('GET .../versions/does-not-exist returns 404', async () => {
    try {
      await getJson(`${baseUrl}/dartregistries/pub.dev/packages/http/versions/99.99.99`);
      assert.fail('should have thrown');
    } catch (err) {
      assert.equal(err.status, 404);
    }
  });

  // ── HTTP method guard ──────────────────────────────────────────────────

  it('POST to packages collection returns 405', async () => {
    const res = await fetch(`${baseUrl}/dartregistries/pub.dev/packages`, {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(res.status, 405);
  });

  it('GET response includes CORS header', async () => {
    const res = await fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(5000) });
    assert.ok(res.headers.get('access-control-allow-origin'), 'CORS header present');
  });
});
