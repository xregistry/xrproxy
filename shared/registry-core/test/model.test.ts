import assert from 'node:assert/strict';
import test from 'node:test';
import { expandRegistryModel } from '../src';

test('expands sparse rc2 model source across Registry, Group, Version, Resource and Meta scopes', () => {
  const source = {
    groups: {
      packageregistries: {
        singular: 'packageregistry',
        resources: {
          packages: {
            singular: 'package',
            hasdocument: false,
            attributes: { checksum: { type: 'string' } },
          },
        },
      },
    },
  } as const;
  const before = JSON.parse(JSON.stringify(source));
  const model = expandRegistryModel(source);
  assert.deepEqual(source, before, 'expansion must not mutate modelsource');
  const registryAttributes = model['attributes'] as Record<string, unknown>;
  for (const name of ['specversion', 'registryid', 'model', 'modelsource', 'packageregistriesurl', 'packageregistriescount']) {
    assert.ok(registryAttributes[name], `missing Registry attribute ${name}`);
  }
  const group = (model['groups'] as any).packageregistries;
  for (const name of ['packageregistryid', 'self', 'xid', 'epoch', 'packagesurl', 'packagescount']) {
    assert.ok(group.attributes[name], `missing Group attribute ${name}`);
  }
  const resource = group.resources.packages;
  for (const name of ['packageid', 'versionid', 'self', 'xid', 'isdefault', 'ancestor', 'checksum']) {
    assert.ok(resource.attributes[name], `missing Version attribute ${name}`);
  }
  for (const name of ['packageid', 'self', 'xid', 'metaurl', 'meta', 'versionsurl', 'versionscount', 'versions']) {
    assert.ok(resource.resourceattributes[name], `missing Resource attribute ${name}`);
  }
  for (const name of ['packageid', 'self', 'xid', 'readonly', 'defaultversionid', 'defaultversionurl', 'defaultversionsticky']) {
    assert.ok(resource.metaattributes[name], `missing Meta attribute ${name}`);
  }
  assert.equal(resource.attributes.package, undefined, 'hasdocument=false must omit document attributes');
});

test('source overrides are retained while required built-in aspects remain present', () => {
  const model = expandRegistryModel({
    groups: {
      groups: {
        singular: 'group',
        resources: {
          things: {
            singular: 'thing',
            attributes: { description: { type: 'string', description: 'domain override' } },
          },
        },
      },
    },
  });
  const description = (model['groups'] as any).groups.resources.things.attributes.description;
  assert.equal(description.name, 'description');
  assert.equal(description.type, 'string');
  assert.equal(description.description, 'domain override');
  assert.ok((model['groups'] as any).groups.resources.things.attributes.thing);
});
