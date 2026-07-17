import { Request, Response } from 'express';
import { GROUP_CONFIG } from '../../../src/config/constants';
import { RegistryService } from '../../../src/services/registry-service';
import { RubyGemsService } from '../../../src/services/rubygems-service';
import { NOKOGIRI_GEM_FIXTURE, NOKOGIRI_VERSIONS_FIXTURE, RACK_GEM_FIXTURE, RACK_VERSIONS_FIXTURE } from '../../fixtures/rubygems-fixtures';

function createResponse(): Response {
    return {
        json: jest.fn(),
        set: jest.fn().mockReturnThis(),
        status: jest.fn().mockReturnThis(),
        type: jest.fn().mockReturnThis(),
    } as unknown as Response;
}

function createRequest(path: string, params: Record<string, string> = {}, query: Record<string, string> = {}): Request {
    return {
        protocol: 'https',
        path,
        originalUrl: path,
        params,
        query,
        get: jest.fn((header: string) => {
            const normalized = header.toLowerCase();
            if (normalized === 'host') return 'registry.example.com';
            if (normalized === 'x-forwarded-host') return undefined;
            if (normalized === 'x-forwarded-proto') return undefined;
            if (normalized === 'x-base-url') return undefined;
            return undefined;
        }),
    } as unknown as Request;
}

describe('RegistryService', () => {
    let rubygemsService: jest.Mocked<RubyGemsService>;
    let registryService: RegistryService;

    beforeEach(() => {
        rubygemsService = {
            getGem: jest.fn(),
            getVersions: jest.fn(),
            searchGems: jest.fn(),
        } as unknown as jest.Mocked<RubyGemsService>;
        registryService = new RegistryService(rubygemsService);
    });

    test('returns the registry root response', async () => {
        const req = createRequest('/');
        const res = createResponse();

        await registryService.getRegistry(req, res);

        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            registryid: 'rubygems-wrapper',
            specversion: '1.0-rc2',
            xid: '/',
            rubyregistriesurl: 'https://registry.example.com/rubyregistries',
            rubyregistriescount: 1,
        }));
    });

    test('returns the group listing', async () => {
        const req = createRequest('/rubyregistries');
        const res = createResponse();

        await registryService.getGroups(req, res);

        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            'rubygems.org': expect.objectContaining({
                rubyregistryid: 'rubygems.org',
                packagesurl: 'https://registry.example.com/rubyregistries/rubygems.org/packages',
            }),
        }));
    });

    test('paginates package search results', async () => {
        rubygemsService.searchGems
            .mockResolvedValueOnce([RACK_GEM_FIXTURE, { ...RACK_GEM_FIXTURE, name: 'rack-test' }])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([]);

        const req = createRequest(`/${GROUP_CONFIG.TYPE}/${GROUP_CONFIG.ID}/packages`, { groupId: GROUP_CONFIG.ID }, { search: 'rack', offset: '1', limit: '1' });
        const res = createResponse();

        await registryService.getResources(req, res);

        expect(res.set).toHaveBeenCalledWith('Link', expect.stringContaining('rel="prev"'));
        expect(res.json).toHaveBeenCalledWith({
            'rack-test': expect.objectContaining({
                packageid: 'rack-test',
            }),
        });
    });

    test('returns a specific package', async () => {
        rubygemsService.getGem.mockResolvedValue(RACK_GEM_FIXTURE);

        const req = createRequest(`/${GROUP_CONFIG.TYPE}/${GROUP_CONFIG.ID}/packages/rack`, { groupId: GROUP_CONFIG.ID, name: 'rack' });
        const res = createResponse();

        await registryService.getResource(req, res);

        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            packageid: 'rack',
            versionsurl: 'https://registry.example.com/rubyregistries/rubygems.org/packages/rack/versions',
        }));
        // versionscount must NOT appear without inline=versions (no N+1 fetch)
        const call = (res.json as jest.Mock).mock.calls[0][0] as Record<string, unknown>;
        expect(call['versionscount']).toBeUndefined();
    });

    test('includes versionscount when inline=versions is requested', async () => {
        rubygemsService.getGem.mockResolvedValue(RACK_GEM_FIXTURE);
        rubygemsService.getVersions.mockResolvedValue(RACK_VERSIONS_FIXTURE);

        const req = createRequest(
            `/${GROUP_CONFIG.TYPE}/${GROUP_CONFIG.ID}/packages/rack`,
            { groupId: GROUP_CONFIG.ID, name: 'rack' },
            { inline: 'versions' },
        );
        const res = createResponse();

        await registryService.getResource(req, res);

        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            packageid: 'rack',
            versionscount: RACK_VERSIONS_FIXTURE.length,
        }));
    });

    test('returns version IDs with platform suffixes when needed', async () => {
        rubygemsService.getGem.mockResolvedValue(NOKOGIRI_GEM_FIXTURE);
        rubygemsService.getVersions.mockResolvedValue(NOKOGIRI_VERSIONS_FIXTURE);

        const req = createRequest(`/${GROUP_CONFIG.TYPE}/${GROUP_CONFIG.ID}/packages/nokogiri/versions`, { groupId: GROUP_CONFIG.ID, name: 'nokogiri' });
        const res = createResponse();

        await registryService.getVersions(req, res);

        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            '1.18.0': expect.objectContaining({ platform: 'ruby' }),
            '1.18.0-x86_64-linux': expect.objectContaining({ platform: 'x86_64-linux' }),
            '1.18.0-arm64-darwin': expect.objectContaining({ platform: 'arm64-darwin' }),
        }));
    });

    test('resolves a specific platform build from versionId', async () => {
        rubygemsService.getGem.mockResolvedValue(NOKOGIRI_GEM_FIXTURE);
        rubygemsService.getVersions.mockResolvedValue(NOKOGIRI_VERSIONS_FIXTURE);

        const req = createRequest(
            `/${GROUP_CONFIG.TYPE}/${GROUP_CONFIG.ID}/packages/nokogiri/versions/1.18.0-arm64-darwin`,
            { groupId: GROUP_CONFIG.ID, name: 'nokogiri', versionId: '1.18.0-arm64-darwin' },
        );
        const res = createResponse();

        await registryService.getVersion(req, res);

        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            versionid: '1.18.0-arm64-darwin',
            platform: 'arm64-darwin',
            number: '1.18.0',
        }));
    });
});

