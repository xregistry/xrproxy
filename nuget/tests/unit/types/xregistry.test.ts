import { Group, Meta, Registry, Resource, Version, XRegistryEntity } from '../../../src/types/xregistry';
import '../../setup';

describe('xRegistry Types', () => {
    test('validates the common xRegistry entity shape', () => {
        const entity: XRegistryEntity = { xid: '/test/entity', self: 'http://example.com/test/entity', epoch: 1, createdat: '2023-01-01T00:00:00Z', modifiedat: '2023-01-01T00:00:00Z' };
        expect(entity).toBeValidXRegistryEntity();
    });

    test('models the registry root', () => {
        const registry: Registry = { xid: '/', self: 'http://example.com', epoch: 1, createdat: '2023-01-01T00:00:00Z', modifiedat: '2023-01-01T00:00:00Z', specversion: '1.0-rc2', registryid: 'nuget-wrapper', modelurl: 'http://example.com/model', capabilitiesurl: 'http://example.com/capabilities', dotnetregistriesurl: 'http://example.com/dotnetregistries', dotnetregistriescount: 1 };
        expect(registry).toBeValidXRegistryEntity();
    });

    test('models the dotnetregistry group projection', () => {
        const group: Group = { dotnetregistryid: 'nuget', xid: '/dotnetregistries/nuget', self: 'http://example.com/dotnetregistries/nuget', epoch: 1, createdat: '2023-01-01T00:00:00Z', modifiedat: '2023-01-01T00:00:00Z', packagesurl: 'http://example.com/dotnetregistries/nuget/packages', packagescount: 1, sourceurl: 'https://api.nuget.org/v3/index.json' };
        expect(group).toBeValidXRegistryEntity();
        expect(group.dotnetregistryid).toBe('nuget');
    });

    test('models a package resource with snake_case extension attributes', () => {
        const resource: Resource = { packageid: 'newtonsoft.json', versionid: '13.0.3', ancestor: '13.0.2', xid: '/dotnetregistries/nuget/packages/newtonsoft.json', self: 'http://example.com/dotnetregistries/nuget/packages/newtonsoft.json', epoch: 1, createdat: '2023-01-01T00:00:00Z', modifiedat: '2023-01-01T00:00:00Z', name: 'Newtonsoft.Json', title: 'Json.NET', authors: ['James Newton-King'], icon_url: 'https://example.com/icon.png', package_content: 'https://example.com/pkg.nupkg', metaurl: 'http://example.com/dotnetregistries/nuget/packages/newtonsoft.json/meta', versionsurl: 'http://example.com/dotnetregistries/nuget/packages/newtonsoft.json/versions', versionscount: 1 };
        expect(resource).toBeValidXRegistryResource();
        expect(resource.package_content).toContain('.nupkg');
    });

    test('models a version entity using versionid instead of the raw upstream identifier', () => {
        const version: Version = { packageid: 'example.pkg', versionid: '1.0.0~build.5', ancestor: '1.0.0', xid: '/dotnetregistries/nuget/packages/example.pkg/versions/1.0.0~build.5', self: 'http://example.com/dotnetregistries/nuget/packages/example.pkg/versions/1.0.0~build.5', epoch: 1, createdat: '2023-01-01T00:00:00Z', modifiedat: '2023-01-01T00:00:00Z', version: '1.0.0+build.5' };
        expect(version).toBeValidXRegistryEntity();
        expect(version.version).toBe('1.0.0+build.5');
    });

    test('models package meta attributes on the meta sub-entity', () => {
        const meta: Meta = { packageid: 'newtonsoft.json', xid: '/dotnetregistries/nuget/packages/newtonsoft.json/meta', self: 'http://example.com/dotnetregistries/nuget/packages/newtonsoft.json/meta', epoch: 1, createdat: '2023-01-01T00:00:00Z', modifiedat: '2023-01-01T00:00:00Z', owners: ['JamesNK'], total_downloads: 100, verified: true, defaultversionid: '13.0.3' };
        expect(meta).toBeValidXRegistryEntity();
        expect(meta.owners).toEqual(['JamesNK']);
    });
});
