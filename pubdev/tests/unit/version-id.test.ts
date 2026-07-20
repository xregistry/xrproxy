import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import express from 'express';
import * as path from 'node:path';
import test from 'node:test';
import modelData from '../../model.json';
import { EntityStateManager } from '../../../shared/entity-state-manager';
import { createPackageRoutes } from '../../src/routes/packages';
import { PackageService } from '../../src/services/package-service';
import type { SearchService } from '../../src/services/search-service';
import type { PubDevService } from '../../src/services/pubdev-service';
import { decodePubDevVersionId, encodePubDevVersionId } from '../../src/utils/version-id';

const repositoryRoot = path.basename(process.cwd()).toLowerCase() === 'pubdev'
  ? path.resolve(process.cwd(), '..')
  : process.cwd();
const {
  assertMetaConforms,
  assertResourceConforms,
  assertResourceProjectsVersion,
  assertVersionConforms,
} = require(path.join(repositoryRoot, 'test/helpers/xregistry-model-conformance.cjs'));

test('pub.dev + versions use reversible xRegistry-safe IDs', () => {
  const raw = '1.2.3+build.7';
  const id = encodePubDevVersionId(raw);
  assert.match(id, /^[A-Za-z0-9_][A-Za-z0-9._~:@-]*$/);
  assert.ok(!id.includes('+'));
  assert.equal(decodePubDevVersionId(id), raw);
});

test('safe versions stay stable and encoded-prefix versions cannot collide', () => {
  assert.equal(encodePubDevVersionId('1.2.3-beta.1'), '1.2.3-beta.1');
  const encoded = encodePubDevVersionId('xv~collision');
  assert.notEqual(encoded, 'xv~collision');
  assert.equal(decodePubDevVersionId(encoded), 'xv~collision');
  assert.equal(decodePubDevVersionId('xv~%%%'), null);
});

test('PackageService retains raw + version while using encoded lineage IDs', async () => {
  const pkg = {
    name: 'example',
    latest: {
      version: '1.0.0+1',
      pubspec: { name: 'example', version: '1.0.0+1' },
      published: '2024-01-01T00:00:00.000Z',
    },
    versions: [
      { version: '1.0.0+1', pubspec: { name: 'example', version: '1.0.0+1' }, published: '2024-01-01T00:00:00.000Z' },
      { version: '1.0.0+2', pubspec: { name: 'example', version: '1.0.0+2' }, published: '2024-02-01T00:00:00.000Z' },
    ],
  };
  const upstream = {
    fetchPackage: async () => pkg,
    fetchScore: async () => ({ likeCount: 7, grantedPoints: 140, popularityScore: 0.8 }),
    fetchPublisher: async () => ({ publisherId: 'example.dev' }),
  } as unknown as PubDevService;
  const service = new PackageService(upstream, new EntityStateManager());
  const base = 'https://registry.example.test';
  const latestId = encodePubDevVersionId('1.0.0+2');
  const ancestor = encodePubDevVersionId('1.0.0+1');

  const resource = await service.getPackageMetadata('example', base);
  assert.equal(resource['versionid'], latestId);
  assert.equal(resource['ancestor'], ancestor);
  assertResourceConforms(modelData, 'dartregistries', 'packages', resource, 'pubdev.resource');
  assert.equal(Object.hasOwn(resource, 'defaultversionurl'), false);
  assert.equal(Object.hasOwn(resource, 'likes'), false);

  const versions = await service.getPackageVersions('example', base);
  const latest = versions[latestId] as Record<string, unknown>;
  assert.equal(latest['version'], '1.0.0+2');
  assert.equal(latest['ancestor'], ancestor);
  assert.equal(latest['packageid'], 'example');
  for (const [id, version] of Object.entries(versions)) {
    assertVersionConforms(modelData, 'dartregistries', 'packages', version, `pubdev.version.${id}`);
  }
  assertResourceProjectsVersion(modelData, 'dartregistries', 'packages', resource, latest, 'pubdev.resource');

  const exact = await service.getVersionDetails('example', latestId, base);
  assert.equal(exact['version'], '1.0.0+2');
  assert.equal(exact['versionid'], latestId);
  assertVersionConforms(modelData, 'dartregistries', 'packages', exact, 'pubdev.exact-version');

  const meta = await service.getPackageMeta('example', base);
  assert.equal(meta['defaultversionid'], latestId);
  assert.equal(meta['defaultversionsticky'], false);
  assert.equal(Object.hasOwn(meta, 'ancestor'), false);
  assert.equal(meta['publisher'], 'example.dev');
  assert.equal(meta['likes'], 7);
  assertMetaConforms(modelData, 'dartregistries', 'packages', meta, 'pubdev.meta');
});


test('package collection entries are complete and exactly match Resource reads', async () => {
  const pkg = {
    name: 'example',
    latest: { version: '1.0.0', pubspec: { name: 'example', version: '1.0.0' }, published: '2024-01-01T00:00:00.000Z' },
    versions: [
      { version: '1.0.0', pubspec: { name: 'example', version: '1.0.0' }, published: '2024-01-01T00:00:00.000Z' },
    ],
  };
  const upstream = {
    fetchPackage: async () => pkg,
    fetchScore: async () => null,
    fetchPublisher: async () => null,
  } as unknown as PubDevService;
  const state = new EntityStateManager();
  const packages = new PackageService(upstream, state);
  const search = {
    getAll: () => ['example'],
    isAuthoritative: () => true,
    exists: async (name: string) => name === 'example',
  } as unknown as SearchService;
  const app = express();
  app.use(createPackageRoutes(packages, search, state));
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const collection = await (await fetch(`${base}/dartregistries/pub.dev/packages?limit=1`)).json() as Record<string, unknown>;
    const exact = await (await fetch(`${base}/dartregistries/pub.dev/packages/example`)).json() as Record<string, unknown>;
    assert.deepEqual(collection['example'], exact);
    for (const name of ['versionid', 'isdefault', 'ancestor', 'versionscount']) {
      assert.ok((collection['example'] as Record<string, unknown>)[name] !== undefined, name);
    }
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
