/**
 * Unit tests for xRegistry type definitions.
 */

import { Group, Meta, Registry, Resource, Version, XRegistryEntity } from '../../../src/types/xregistry';
import '../../setup';

describe('xRegistry Types', () => {
    test('defines the shared entity contract', () => {
        const entity: XRegistryEntity = {
            xid: '/nodescopes/_',
            self: 'https://example.com/nodescopes/_',
            epoch: 1,
            createdat: '2023-01-01T00:00:00Z',
            modifiedat: '2023-01-01T00:00:00Z',
        };

        expect(entity).toBeValidXRegistryEntity();
    });

    test('defines registry and group shapes for nodescopes', () => {
        const group: Group = {
            xid: '/nodescopes/_',
            self: 'https://example.com/nodescopes/_',
            epoch: 1,
            createdat: '2023-01-01T00:00:00Z',
            modifiedat: '2023-01-01T00:00:00Z',
            nodescopeid: '_',
            packagesurl: 'https://example.com/nodescopes/_/packages',
            packagescount: 1,
        };

        const registry: Registry = {
            xid: '/',
            self: 'https://example.com',
            epoch: 1,
            createdat: '2023-01-01T00:00:00Z',
            modifiedat: '2023-01-01T00:00:00Z',
            specversion: '1.0-rc2',
            registryid: 'npm-wrapper',
            nodescopesurl: 'https://example.com/nodescopes',
            nodescopescount: 1,
            nodescopes: { _: group },
        };

        expect(group).toBeValidXRegistryEntity();
        expect(registry).toBeValidXRegistryEntity();
    });

    test('defines package and version shapes', () => {
        const resource: Resource = {
            xid: '/nodescopes/babel/packages/core',
            self: 'https://example.com/nodescopes/babel/packages/core',
            epoch: 1,
            createdat: '2023-01-01T00:00:00Z',
            modifiedat: '2023-01-01T00:00:00Z',
            packageid: 'core',
            name: '@babel/core',
            versionid: '7.0.0',
            version: '7.0.0',
            'dist-tags': { latest: '7.0.0' },
        };

        const version: Version = {
            xid: '/nodescopes/babel/packages/core/versions/7.0.0',
            self: 'https://example.com/nodescopes/babel/packages/core/versions/7.0.0',
            epoch: 1,
            createdat: '2023-01-01T00:00:00Z',
            modifiedat: '2023-01-01T00:00:00Z',
            versionid: '7.0.0',
            packageid: 'core',
        };

        expect(resource).toBeValidXRegistryResource();
        expect(version).toBeValidXRegistryEntity();
    });

    test('defines resource meta shape', () => {
        const meta: Meta = {
            xid: '/nodescopes/_/packages/express/meta',
            self: 'https://example.com/nodescopes/_/packages/express/meta',
            epoch: 1,
            createdat: '2023-01-01T00:00:00Z',
            modifiedat: '2023-01-01T00:00:00Z',
            readonly: true,
            compatibility: 'strict',
            defaultversionid: '1.0.0',
        };

        expect(meta).toBeValidXRegistryEntity();
    });
});
