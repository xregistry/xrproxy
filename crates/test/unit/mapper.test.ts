import assert from 'node:assert/strict';
import test from 'node:test';
import { mapCrate, mapGroup, mapRegistryRoot, mapVersion } from '../../src/mapper';
import { FIXTURE_CRATE_SERDE } from '../../src/fixtures';

const BASE_URL = 'http://localhost:3700';

test('mapRegistryRoot has required xRegistry fields', () => {
  const root = mapRegistryRoot(BASE_URL, `${BASE_URL}/rustregistries`);
  assert.equal(root.registryid, 'crates.io');
  assert.equal(root.self, BASE_URL);
  assert.equal(root.xid, '/');
  assert.ok(typeof root.epoch === 'number' && root.epoch >= 1);
  assert.ok(typeof root.createdat === 'string');
  assert.ok(typeof root.modifiedat === 'string');
  assert.equal(root.rustregistriesurl, `${BASE_URL}/rustregistries`);
});

test('mapGroup produces valid xRegistry group', () => {
  const group = mapGroup(BASE_URL);
  assert.equal(group.xid, '/rustregistries/crates.io');
  assert.ok(group.self.includes('/rustregistries/crates.io'));
  assert.ok(group.description.length > 0);
  assert.ok(typeof group.cratesurl === 'string' && group.cratesurl.includes('/crates'));
  assert.equal(group.epoch, 1);
});

test('mapCrate uses crate name as crateid', () => {
  const crate = mapCrate(FIXTURE_CRATE_SERDE.crate, BASE_URL);
  assert.equal(crate.crateid, 'serde');
  assert.equal(crate.name, 'serde');
  assert.ok(crate.self.includes('/crates/serde'));
  assert.ok(crate.xid.includes('/crates/serde'));
  assert.ok(typeof crate.versionsurl === 'string' && crate.versionsurl.includes('/versions'));
});

test('mapCrate preserves upstream fields', () => {
  const crate = mapCrate(FIXTURE_CRATE_SERDE.crate, BASE_URL);
  assert.equal(crate.description, FIXTURE_CRATE_SERDE.crate.description);
  assert.equal(crate.max_version, '1.0.219');
  assert.equal(crate.max_stable_version, '1.0.219');
  assert.equal(crate.license, 'MIT OR Apache-2.0');
  assert.deepEqual(crate.keywords, ['serde', 'serialization', 'no_std']);
  assert.equal(crate.downloads, 450000000);
});

test('mapCrate epoch is deterministic from updated_at', () => {
  const crate = mapCrate(FIXTURE_CRATE_SERDE.crate, BASE_URL);
  const expected = Math.floor(Date.parse('2025-01-01T00:00:00.000Z') / 1000);
  assert.equal(crate.epoch, expected);
});

test('mapVersion sets immutable to true', () => {
  const version = FIXTURE_CRATE_SERDE.versions[0]!;
  const mapped = mapVersion(version, '1.0.219', BASE_URL);
  assert.equal(mapped.immutable, true);
  assert.equal(mapped.versionid, '1.0.219');
  assert.equal(mapped.yanked, false);
  assert.equal(mapped.license, 'MIT OR Apache-2.0');
});

test('mapVersion sets isdefault for max_stable_version', () => {
  const version1 = FIXTURE_CRATE_SERDE.versions[0]!;
  const version2 = FIXTURE_CRATE_SERDE.versions[1]!;
  const mapped1 = mapVersion(version1, '1.0.219', BASE_URL);
  const mapped2 = mapVersion(version2, '1.0.219', BASE_URL);
  assert.equal(mapped1.isdefault, true);
  assert.equal(mapped2.isdefault, false);
});
