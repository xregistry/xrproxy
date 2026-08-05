import { Request, Response } from 'express';
import { RegistryService } from '../src/services/registry-service';

describe('Maven RegistryService namespace counts', () => {
    test('uses facet counts returned with the namespace page without per-namespace queries', async () => {
        const searchService = {
            listNamespaces: jest.fn().mockResolvedValue({
                results: [{ groupId: 'org.example', namespaceId: 'org.example', packageCount: 42 }],
                totalCount: 1,
            }),
            countPackagesInNamespace: jest.fn(),
        };
        const service = new RegistryService({ searchService: searchService as any });
        const request = {
            protocol: 'https',
            query: { limit: '50', offset: '0' },
            get: jest.fn((name: string) => name === 'host' ? 'registry.example.test' : undefined),
        } as unknown as Request;
        const response = {
            setHeader: jest.fn(),
            json: jest.fn(),
        } as unknown as Response;

        await service.getGroups(request, response);

        expect(searchService.countPackagesInNamespace).not.toHaveBeenCalled();
        expect(response.json).toHaveBeenCalledWith({
            'org.example': expect.objectContaining({ packagescount: 42 }),
        });
    });
});
