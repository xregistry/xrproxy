import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveVersionId, mapCrate, mapCrateMeta, mapGroup, mapRegistryRoot, mapVersion, resolveDefaultVersion } from '../../src/mapper';
import { FIXTURE_CRATE_SERDE, FIXTURE_CRATE_TOKIO } from '../../src/fixtures';

const BASE_URL = 'http://localhost:3700';

test('mapRegistryRoot has required xRegistry fields', () => {
  const root = mapRegistryRoot(BASE_URL, `${BASE_URL}/rustregistries`);
  assert.equal(root.registryid, 'crates-io');
  assert.equal(root.self, BASE_URL);
  assert.equal(root.xid, '/');
  assert.ok(typeof root.epoch === 'number' && root.epoch >= 1);
  assert.ok(typeof root.createdat === 'string');
  assert.ok(typeof root.modifiedat === 'string');
  assert.equal(root.rustregistriesurl, `${BASE_URL}/rustregistries`);
  assert.equal(root.rustregistriescount, 1);
});

test('mapGroup produces a crates-io projection with sourceurl', () => {
  const group = mapGroup(BASE_URL, 'https://index.crates.io');
  assert.equal(group.rustregistryid, 'crates-io');
  assert.equal(group.xid, '/rustregistries/crates-io');
  assert.equal(group.sourceurl, 'https://index.crates.io');
  assert.ok(typeof group.cratesurl === 'string' && group.cratesurl.includes('/crates'));
});

test('deriveVersionId replaces build metadata separators with tildes', () => {
  assert.equal(deriveVersionId('1.45.1+exp.sha.1'), '1.45.1~exp.sha.1');
  assert.equal(deriveVersionId('1.0.218'), '1.0.218');
});

test('resolveDefaultVersion prefers the upstream default_version', () => {
  assert.equal(resolveDefaultVersion(FIXTURE_CRATE_SERDE.crate, FIXTURE_CRATE_SERDE.versions), '1.0.218');
});

test('mapCrate projects default-version attributes at the resource root and crate-wide fields in meta', () => {
  const crate = mapCrate(FIXTURE_CRATE_SERDE, BASE_URL);
  assert.equal(crate.crateid, 'serde');
  assert.equal(crate.versionid, '1.0.218');
  assert.equal(crate.createdat, '2024-12-01T00:00:00.000Z');
  assert.equal(crate.modifiedat, '2024-12-01T00:00:00.000Z');
  assert.equal(crate.downloads, 3_000_000);
  assert.equal(crate.meta.downloads, 450_000_000);
  assert.equal(crate.meta.default_version, '1.0.218');
  assert.equal(crate.meta.max_version, '1.0.219');
  assert.equal(crate.meta.defaultversionid, '1.0.218');
  assert.equal(crate.meta.defaultversionsticky, false);
  assert.equal(crate.meta.yanked, false);
  assert.ok(Array.isArray(crate.meta.owners));
  assert.equal((crate.meta.crate_links as Record<string, unknown>).owners, '/api/v1/crates/serde/owners');
  assert.equal((crate as Record<string, unknown>)['isdefault'], undefined);
  assert.equal((crate as Record<string, unknown>)['immutable'], undefined);
  assert.equal(crate.license, 'MIT OR Apache-2.0');
  assert.equal(crate.yanked, false);
  assert.deepEqual(crate.dependencies, [{
    name: 'serde_derive_alias',
    req: '^1.0',
    features: ['std'],
    optional: true,
    default_features: false,
    target: 'cfg(unix)',
    kind: 'dev',
    registry: 'https://example.invalid/index',
    package: 'serde_derive'
  }]);
});

test('mapCrateMeta uses crate timestamps and exposes the derived defaultversionurl', () => {
  const meta = mapCrateMeta(FIXTURE_CRATE_TOKIO, BASE_URL);
  assert.equal(meta.createdat, '2016-08-18T20:21:39.000Z');
  assert.equal(meta.modifiedat, '2025-02-01T00:00:00.000Z');
  assert.equal(meta.defaultversionid, '1.45.1~exp.sha.1');
  assert.equal(meta.defaultversionurl, `${BASE_URL}/rustregistries/crates-io/crates/tokio/versions/1.45.1~exp.sha.1`);
});

test('mapVersion sets immutable, keeps num verbatim, and uses the derived versionid', () => {
  const version = FIXTURE_CRATE_TOKIO.versions[0]!;
  const mapped = mapVersion(version, '1.45.1+exp.sha.1', BASE_URL);
  assert.equal(mapped.crateid, 'tokio');
  assert.equal(mapped.versionid, '1.45.1~exp.sha.1');
  assert.equal(mapped.num, '1.45.1+exp.sha.1');
  assert.equal(mapped.ancestor, '1.45.1~exp.sha.1');
  assert.equal(mapped.isdefault, true);
  assert.equal(mapped.immutable, true);
  assert.equal(mapped.lib_links, 'tokio_native');
  assert.equal(mapped.cksum, 'tokiotokiotokiotokiotokiotokiotokiotokiotokiotokiotokiotokiotokio');
  assert.deepEqual(mapped.features2, { unstable: ['dep:tokio-macros'] });
  assert.deepEqual(mapped.dependencies, [{
    name: 'bytes',
    req: '^1',
    features: [],
    optional: false,
    default_features: true,
    kind: 'normal'
  }]);
});

test('mapVersion preserves published_by and audit_actions as structured objects', () => {
  const version = FIXTURE_CRATE_SERDE.versions[0]!;
  const mapped = mapVersion(version, '1.0.218', BASE_URL);
  assert.deepEqual(mapped.published_by, {
    id: 3618,
    login: 'dtolnay',
    name: 'David Tolnay',
    url: 'https://github.com/dtolnay',
    avatar: 'https://avatars.githubusercontent.com/u/1940490?v=4'
  });
  assert.deepEqual(mapped.audit_actions, [
    {
      action: 'publish',
      time: '2025-01-01T00:00:00.000Z',
      user: {
        id: 3618,
        login: 'dtolnay',
        name: 'David Tolnay',
        url: 'https://github.com/dtolnay',
        avatar: 'https://avatars.githubusercontent.com/u/1940490?v=4'
      }
    },
    {
      action: 'yank',
      time: '2025-01-02T00:00:00.000Z',
      user: {
        id: 3618,
        login: 'dtolnay',
        name: 'David Tolnay',
        url: 'https://github.com/dtolnay',
        avatar: 'https://avatars.githubusercontent.com/u/1940490?v=4'
      }
    }
  ]);
});
