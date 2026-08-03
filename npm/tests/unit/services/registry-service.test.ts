/**
 * Unit tests for Registry Service.
 */

import { Request, Response } from 'express';
import { CacheService } from '../../../src/cache/cache-service';
import { NpmService } from '../../../src/services/npm-service';
import { RegistryService, RegistryServiceOptions } from '../../../src/services/registry-service';

jest.mock('../../../src/services/npm-service');
jest.mock('../../../src/cache/cache-service');

describe('RegistryService', () => {
    let registryService: RegistryService;
    let mockNpmService: jest.Mocked<NpmService>;
    let mockCacheService: jest.Mocked<CacheService>;
    let mockRequest: Partial<Request>;
    let mockResponse: Partial<Response>;

    beforeEach(() => {
        mockNpmService = {
            getKnownPackageNames: jest.fn().mockResolvedValue(['express', '@babel/core']),
            resolveCanonicalPackageName: jest.fn().mockImplementation(async (nodescopeId: string, packageId: string) => {
                if (nodescopeId === '_' && packageId === 'express') return 'express';
                if (nodescopeId === 'babel' && packageId === 'core') return '@babel/core';
                return null;
            }),
            getPackageMetadata: jest.fn().mockResolvedValue({
                name: '@babel/core',
                packageid: 'core',
                xid: '/nodescopes/babel/packages/core',
                self: 'https://registry.example.com/nodescopes/babel/packages/core',
                epoch: 1,
                createdat: '2024-01-01T00:00:00.000Z',
                modifiedat: '2024-01-02T00:00:00.000Z',
                versions: { '7.0.0': {} },
                time: {},
            } as any),
        } as any;

        mockCacheService = { get: jest.fn(), set: jest.fn(), delete: jest.fn(), clear: jest.fn(), getStats: jest.fn() } as any;

        const options: RegistryServiceOptions = {
            npmService: mockNpmService,
            cacheService: mockCacheService,
            logger: console,
        };
        registryService = new RegistryService(options);

        mockRequest = {
            protocol: 'https',
            get: jest.fn().mockReturnValue('registry.example.com'),
            originalUrl: '/',
            path: '/',
            query: {},
            params: {},
        };

        mockResponse = {
            set: jest.fn(),
            json: jest.fn(),
            status: jest.fn().mockReturnThis(),
        };
    });

    test('returns a registry root with nodescopes metadata', async () => {
        await registryService.getRegistry(mockRequest as Request, mockResponse as Response);

        expect(mockResponse.json).toHaveBeenCalledWith(expect.objectContaining({
            xid: '/',
            self: 'https://registry.example.com',
            nodescopesurl: 'https://registry.example.com/nodescopes',
            nodescopescount: 2,
        }));
    });

    test('returns inline nodescope groups', async () => {
        mockRequest.query = { inline: 'true' };

        await registryService.getRegistry(mockRequest as Request, mockResponse as Response);

        expect(mockResponse.json).toHaveBeenCalledWith(expect.objectContaining({
            nodescopes: expect.objectContaining({
                _: expect.objectContaining({ nodescopeid: '_' }),
                babel: expect.objectContaining({ nodescopeid: 'babel', scope: 'babel' }),
            }),
        }));
    });

    test('returns a concrete group entity', async () => {
        mockRequest.params = { nodescopeId: 'babel' };
        mockRequest.originalUrl = '/nodescopes/babel';

        await registryService.getGroup(mockRequest as Request, mockResponse as Response);

        expect(mockResponse.json).toHaveBeenCalledWith(expect.objectContaining({
            nodescopeid: 'babel',
            scope: 'babel',
            packagesurl: 'https://registry.example.com/nodescopes/babel/packages',
        }));
    });

    test('returns resources scoped by nodescope', async () => {
        mockRequest.params = { nodescopeId: '_' };
        mockRequest.originalUrl = '/nodescopes/_/packages';

        await registryService.getResources(mockRequest as Request, mockResponse as Response);

        expect(mockResponse.json).toHaveBeenCalledWith({
            packages: {
                express: expect.objectContaining({ packageid: 'express', name: 'express' }),
            },
        });
    });

    test('returns a concrete package resource', async () => {
        mockRequest.params = { nodescopeId: 'babel', packageId: 'core' };
        mockRequest.originalUrl = '/nodescopes/babel/packages/core';

        await registryService.getResource(mockRequest as Request, mockResponse as Response);

        expect(mockResponse.json).toHaveBeenCalledWith(expect.objectContaining({
            packageid: 'core',
            versionsurl: 'https://registry.example.com/nodescopes/babel/packages/core/versions',
            metaurl: 'https://registry.example.com/nodescopes/babel/packages/core/meta',
        }));
    });
});
