import { UpstreamError } from '@xregistry/registry-core';
import { Request, Response } from 'express';
import * as path from 'node:path';
import modelData from '../../../model.json';
import { GROUP_CONFIG } from '../../../src/config/constants';
import { RegistryService } from '../../../src/services/registry-service';
import { RubyGemsService } from '../../../src/services/rubygems-service';
import { NOKOGIRI_GEM_FIXTURE, NOKOGIRI_VERSIONS_FIXTURE, RACK_GEM_FIXTURE, RACK_VERSIONS_FIXTURE } from '../../fixtures/rubygems-fixtures';

const {
    assertGroupConforms,
    assertMetaConforms,
    assertResourceConforms,
    assertResourceProjectsVersion,
    assertVersionConforms,
} = require(path.join(__dirname, '../../../../test/helpers/xregistry-model-conformance.cjs'));

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
            getGem: jest.fn().mockResolvedValue(null),
            getVersions: jest.fn().mockResolvedValue([]),
            searchGems: jest.fn().mockResolvedValue([]),
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

    test('maps a name prefix filter to RubyGems search', async () => {
        rubygemsService.searchGems.mockResolvedValueOnce([
            { ...RACK_GEM_FIXTURE, name: 'rails' },
            { ...RACK_GEM_FIXTURE, name: 'rails-dom-testing' },
            { ...RACK_GEM_FIXTURE, name: 'trailblazer' },
        ]);

        const req = createRequest(
            `/${GROUP_CONFIG.TYPE}/${GROUP_CONFIG.ID}/packages`,
            { groupId: GROUP_CONFIG.ID },
            { filter: 'name=rails*', offset: '0', limit: '10' },
        );
        const res = createResponse();

        await registryService.getResources(req, res);

        expect(rubygemsService.searchGems).toHaveBeenCalledWith('rails', 1);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            rails: expect.objectContaining({ packageid: 'rails' }),
            'rails-dom-testing': expect.objectContaining({ packageid: 'rails-dom-testing' }),
        }));
        const payload = (res.json as jest.Mock).mock.calls[0][0] as Record<string, unknown>;
        expect(payload['trailblazer']).toBeUndefined();
    });

    test('emits a next link when a full upstream search page may have more results', async () => {
        rubygemsService.searchGems.mockResolvedValueOnce(
            Array.from({ length: 30 }, (_, index) => ({ ...RACK_GEM_FIXTURE, name: `rack-${index}` })),
        );

        const req = createRequest(
            `/${GROUP_CONFIG.TYPE}/${GROUP_CONFIG.ID}/packages`,
            { groupId: GROUP_CONFIG.ID },
            { search: 'rack', offset: '0', limit: '10' },
        );
        const res = createResponse();

        await registryService.getResources(req, res);

        expect(res.set).toHaveBeenCalledWith('Link', expect.stringContaining('rel="next"'));
    });

    test('rejects unsupported deep search offsets with HTTP 400 problem details', async () => {
        const req = createRequest(
            `/${GROUP_CONFIG.TYPE}/${GROUP_CONFIG.ID}/packages`,
            { groupId: GROUP_CONFIG.ID },
            { search: 'rack', offset: '500', limit: '10' },
        );
        const res = createResponse();

        await expect(registryService.getResources(req, res)).rejects.toMatchObject({
            status: 400,
            detail: expect.stringContaining('offsets greater than 499'),
        });
        expect(rubygemsService.searchGems).not.toHaveBeenCalled();
    });

    test('stops when RubyGems repeats a full search page without progress', async () => {
        const repeatedPage = Array.from(
            { length: 30 },
            (_, index) => ({ ...RACK_GEM_FIXTURE, name: `rack-${index}` }),
        );
        rubygemsService.searchGems
            .mockResolvedValueOnce(repeatedPage)
            .mockResolvedValueOnce(repeatedPage);

        const req = createRequest(
            `/${GROUP_CONFIG.TYPE}/${GROUP_CONFIG.ID}/packages`,
            { groupId: GROUP_CONFIG.ID },
            { search: 'rack', offset: '20', limit: '10' },
        );
        const res = createResponse();

        await registryService.getResources(req, res);

        expect(rubygemsService.searchGems).toHaveBeenCalledTimes(2);
        expect(res.set).not.toHaveBeenCalledWith('Link', expect.stringContaining('rel="next"'));
        expect(Object.keys((res.json as jest.Mock).mock.calls[0][0])).toHaveLength(10);
    });

    test('rejects searches that exceed the safe upstream page limit', async () => {
        rubygemsService.searchGems.mockImplementation(async (_query, page) =>
            Array.from(
                { length: 30 },
                (_, index) => ({ ...RACK_GEM_FIXTURE, name: `unrelated-${page}-${index}` }),
            ),
        );

        const req = createRequest(
            `/${GROUP_CONFIG.TYPE}/${GROUP_CONFIG.ID}/packages`,
            { groupId: GROUP_CONFIG.ID },
            { filter: 'name=rails*', offset: '0', limit: '10' },
        );
        const res = createResponse();

        await expect(registryService.getResources(req, res)).rejects.toMatchObject({
            status: 400,
            detail: expect.stringContaining('safe limit of 20 upstream pages'),
        });
        expect(rubygemsService.searchGems).toHaveBeenCalledTimes(20);
    });

    test('caps collection history hydration at the ten-Resource request budget', async () => {
        rubygemsService.getGem.mockImplementation(async (name: string) => ({ ...RACK_GEM_FIXTURE, name }));
        rubygemsService.getVersions.mockResolvedValue(RACK_VERSIONS_FIXTURE);
        const req = createRequest(
            `/${GROUP_CONFIG.TYPE}/${GROUP_CONFIG.ID}/packages`,
            { groupId: GROUP_CONFIG.ID },
            { limit: '100', offset: '0' },
        );
        const res = createResponse();
        await registryService.getResources(req, res);
        expect(rubygemsService.getVersions).toHaveBeenCalledTimes(10);
        expect(Object.keys((res.json as jest.Mock).mock.calls[0][0])).toHaveLength(10);
    });

    test('one history 429 falls back to a summary Resource without collapsing the page', async () => {
        const gems = ['one', 'two', 'three'].map(name => ({ ...RACK_GEM_FIXTURE, name }));
        rubygemsService.searchGems.mockResolvedValue(gems);
        rubygemsService.getVersions.mockImplementation(async (name: string) => {
            if (name === 'two') {
                throw new UpstreamError({ code: 'rate_limited', status: 429, message: 'limited' });
            }
            return RACK_VERSIONS_FIXTURE;
        });
        const req = createRequest(
            `/${GROUP_CONFIG.TYPE}/${GROUP_CONFIG.ID}/packages`,
            { groupId: GROUP_CONFIG.ID },
            { search: 'anything', limit: '3', offset: '0' },
        );
        const res = createResponse();
        await registryService.getResources(req, res);
        const body = (res.json as jest.Mock).mock.calls[0][0] as Record<string, unknown>;
        expect(Object.keys(body).sort()).toEqual(['one', 'three', 'two']);
        expect((body['two'] as Record<string, unknown>)['versionscount']).toBe(1);
        expect(rubygemsService.getVersions).toHaveBeenCalledTimes(3);
    });

    test('returns a specific package', async () => {
        rubygemsService.getGem.mockResolvedValue(RACK_GEM_FIXTURE);
        rubygemsService.getVersions.mockResolvedValue(RACK_VERSIONS_FIXTURE);

        const req = createRequest(`/${GROUP_CONFIG.TYPE}/${GROUP_CONFIG.ID}/packages/rack`, { groupId: GROUP_CONFIG.ID, name: 'rack' });
        const res = createResponse();

        await registryService.getResource(req, res);

        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            packageid: 'rack',
            versionid: expect.any(String),
            isdefault: true,
            versionsurl: 'https://registry.example.com/rubyregistries/rubygems.org/packages/rack/versions',
            ancestor: expect.any(String),
        }));
        const call = (res.json as jest.Mock).mock.calls[0][0] as Record<string, unknown>;
        expect(call['versionscount']).toBe(RACK_VERSIONS_FIXTURE.length);
        expect(call['metaurl']).toBe('https://registry.example.com/rubyregistries/rubygems.org/packages/rack/meta');
        expect(call).not.toHaveProperty('defaultversionurl');
    });

    test('collection and exact resources use the same canonical version snapshot', async () => {
        rubygemsService.searchGems.mockResolvedValue([RACK_GEM_FIXTURE]);
        rubygemsService.getGem.mockResolvedValue(RACK_GEM_FIXTURE);
        rubygemsService.getVersions.mockResolvedValue(RACK_VERSIONS_FIXTURE);

        const collectionReq = createRequest(
            `/${GROUP_CONFIG.TYPE}/${GROUP_CONFIG.ID}/packages`,
            { groupId: GROUP_CONFIG.ID },
            { search: 'rack', limit: '1', offset: '0' },
        );
        const collectionRes = createResponse();
        await registryService.getResources(collectionReq, collectionRes);
        const collection = (collectionRes.json as jest.Mock).mock.calls[0][0]['rack'] as Record<string, unknown>;

        const exactReq = createRequest(
            `/${GROUP_CONFIG.TYPE}/${GROUP_CONFIG.ID}/packages/rack`,
            { groupId: GROUP_CONFIG.ID, name: 'rack' },
        );
        const exactRes = createResponse();
        await registryService.getResource(exactReq, exactRes);
        const exact = (exactRes.json as jest.Mock).mock.calls[0][0] as Record<string, unknown>;

        expect(collection).toEqual(exact);
    });

    test('returns complete rc2 resource meta from the canonical snapshot', async () => {
        rubygemsService.getGem.mockResolvedValue(RACK_GEM_FIXTURE);
        rubygemsService.getVersions.mockResolvedValue(RACK_VERSIONS_FIXTURE);
        const req = createRequest(
            `/${GROUP_CONFIG.TYPE}/${GROUP_CONFIG.ID}/packages/rack/meta`,
            { groupId: GROUP_CONFIG.ID, name: 'rack' },
        );
        const res = createResponse();

        await registryService.getMeta(req, res);

        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            packageid: 'rack',
            xid: '/rubyregistries/rubygems.org/packages/rack/meta',
            readonly: true,
            compatibility: 'none',
            defaultversionid: '3.1.0',
            defaultversionsticky: false,
            downloads: RACK_GEM_FIXTURE.downloads,
        }));
        const meta = (res.json as jest.Mock).mock.calls[0][0] as Record<string, unknown>;
        expect(meta['defaultversionurl']).toContain('/packages/rack/versions/3.1.0');
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

    test('emits fixture-backed group, Resource, Meta, and Version entities conforming to its runtime model', async () => {
        rubygemsService.getGem.mockResolvedValue(RACK_GEM_FIXTURE);
        rubygemsService.getVersions.mockResolvedValue(RACK_VERSIONS_FIXTURE);

        const groupRes = createResponse();
        await registryService.getGroup(
            createRequest('/rubyregistries/rubygems.org', { groupId: GROUP_CONFIG.ID }),
            groupRes,
        );
        assertGroupConforms(
            modelData,
            'rubyregistries',
            (groupRes.json as jest.Mock).mock.calls[0][0],
            'rubygems.group',
        );

        const resourceRes = createResponse();
        await registryService.getResource(
            createRequest('/rubyregistries/rubygems.org/packages/rack', { groupId: GROUP_CONFIG.ID, name: 'rack' }),
            resourceRes,
        );
        assertResourceConforms(
            modelData,
            'rubyregistries',
            'packages',
            (resourceRes.json as jest.Mock).mock.calls[0][0],
            'rubygems.resource',
        );

        const metaRes = createResponse();
        await registryService.getMeta(
            createRequest('/rubyregistries/rubygems.org/packages/rack/meta', { groupId: GROUP_CONFIG.ID, name: 'rack' }),
            metaRes,
        );
        assertMetaConforms(
            modelData,
            'rubyregistries',
            'packages',
            (metaRes.json as jest.Mock).mock.calls[0][0],
            'rubygems.meta',
        );

        const versionsRes = createResponse();
        await registryService.getVersions(
            createRequest('/rubyregistries/rubygems.org/packages/rack/versions', { groupId: GROUP_CONFIG.ID, name: 'rack' }),
            versionsRes,
        );
        for (const [id, version] of Object.entries((versionsRes.json as jest.Mock).mock.calls[0][0])) {
            assertVersionConforms(modelData, 'rubyregistries', 'packages', version, `rubygems.version.${id}`);
        }
        const resource = (resourceRes.json as jest.Mock).mock.calls[0][0] as Record<string, unknown>;
        const versions = (versionsRes.json as jest.Mock).mock.calls[0][0] as Record<string, Record<string, unknown>>;
        assertResourceProjectsVersion(
            modelData, 'rubyregistries', 'packages', resource, versions[String(resource['versionid'])], 'rubygems.resource',
        );
    });

    test('returns version IDs with platform suffixes when needed', async () => {
        rubygemsService.getGem.mockResolvedValue(NOKOGIRI_GEM_FIXTURE);
        rubygemsService.getVersions.mockResolvedValue(NOKOGIRI_VERSIONS_FIXTURE);

        const req = createRequest(`/${GROUP_CONFIG.TYPE}/${GROUP_CONFIG.ID}/packages/nokogiri/versions`, { groupId: GROUP_CONFIG.ID, name: 'nokogiri' });
        const res = createResponse();

        await registryService.getVersions(req, res);

        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            '1.18.0': expect.objectContaining({ platform: 'ruby', ancestor: expect.any(String) }),
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
            isdefault: expect.any(Boolean),
            ancestor: expect.any(String),
            platform: 'arm64-darwin',
            packageid: 'nokogiri',
            number: '1.18.0',
        }));
    });
});
