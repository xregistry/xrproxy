import { Request, Response } from 'express';
import { CacheService } from '../../../src/cache/cache-service';
import { GROUP_CONFIG } from '../../../src/config/constants';
import { NuGetService } from '../../../src/services/nuget-service';
import { RegistryService, RegistryServiceOptions } from '../../../src/services/registry-service';

jest.mock('../../../src/services/nuget-service');
jest.mock('../../../src/cache/cache-service');

describe('RegistryService', () => {
    let registryService: RegistryService;
    let mockNuGetService: jest.Mocked<NuGetService>;
    let mockCacheService: jest.Mocked<CacheService>;
    let mockLogger: { info: jest.Mock; warn: jest.Mock; error: jest.Mock; debug: jest.Mock };
    let mockRequest: Partial<Request>;
    let mockResponse: Partial<Response>;

    beforeEach(() => {
        mockNuGetService = { getPackageMetadata: jest.fn(), getVersionMetadata: jest.fn(), packageExists: jest.fn(), versionExists: jest.fn(), searchPackages: jest.fn(), getTotalPackageCount: jest.fn().mockResolvedValue(0), getPackages: jest.fn().mockResolvedValue({ packages: [], total: 0 }) } as any;
        mockCacheService = { get: jest.fn(), set: jest.fn(), delete: jest.fn(), clear: jest.fn(), getStats: jest.fn() } as any;
        mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
        const options: RegistryServiceOptions = { NuGetService: mockNuGetService, cacheService: mockCacheService, logger: mockLogger };
        registryService = new RegistryService(options);
        mockRequest = { protocol: 'https', get: (jest.fn((header: string) => header === 'host' ? 'registry.example.com' : undefined) as any), originalUrl: '/', path: '/', query: {}, params: {} };
        mockResponse = { set: jest.fn(), json: jest.fn(), status: jest.fn().mockReturnThis() };
    });

    test('creates the service with injected dependencies', () => {
        expect(registryService).toBeInstanceOf(RegistryService);
        expect(registryService['NuGetService']).toBe(mockNuGetService);
        expect(registryService['cacheService']).toBe(mockCacheService);
    });

    test('serves the registry root with dotnetregistries links', async () => {
        await registryService.getRegistry(mockRequest as Request, mockResponse as Response);
        expect(mockResponse.set).toHaveBeenCalledWith('ETag', expect.any(String));
        expect(mockResponse.json).toHaveBeenCalledWith(expect.objectContaining({ xid: '/', self: 'https://registry.example.com', name: 'NuGet Registry Service', dotnetregistriesurl: 'https://registry.example.com/dotnetregistries', dotnetregistriescount: 1 }));
    });

    test('supports inline groups on the registry root', async () => {
        mockRequest.query = { inline: 'true' };
        await registryService.getRegistry(mockRequest as Request, mockResponse as Response);
        expect(mockResponse.json).toHaveBeenCalledWith(expect.objectContaining({ [GROUP_CONFIG.TYPE]: expect.any(Array) }));
    });

    test('removes readonly fields when noreadonly is requested', async () => {
        mockRequest.query = { noreadonly: 'true' };
        await registryService.getRegistry(mockRequest as Request, mockResponse as Response);
        const payload = (mockResponse.json as jest.Mock).mock.calls[0][0];
        expect(payload).not.toHaveProperty('createdat');
        expect(payload).not.toHaveProperty('modifiedat');
    });

    test('removes epoch when noepoch is requested', async () => {
        mockRequest.query = { noepoch: 'true' };
        await registryService.getRegistry(mockRequest as Request, mockResponse as Response);
        const payload = (mockResponse.json as jest.Mock).mock.calls[0][0];
        expect(payload).not.toHaveProperty('epoch');
    });

    test('adds a schema annotation when requested', async () => {
        mockRequest.query = { schema: 'true' };
        await registryService.getRegistry(mockRequest as Request, mockResponse as Response);
        expect(mockResponse.json).toHaveBeenCalledWith(expect.objectContaining({ $schema: 'xRegistry-json/1.0-rc2/registry' }));
    });

    test('reports registry failures as xRegistry internal errors', async () => {
        (mockRequest.get as jest.Mock).mockImplementation(() => { throw new Error('Test error'); });
        await expect(registryService.getRegistry(mockRequest as Request, mockResponse as Response)).rejects.toMatchObject({ status: 500, instance: '/', detail: 'Failed to retrieve registry information' });
    });
});
