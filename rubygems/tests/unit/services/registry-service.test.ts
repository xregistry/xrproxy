import { Request, Response } from 'express';
import * as path from 'node:path';
import modelData from '../../../model.json';
import { GROUP_CONFIG } from '../../../src/config/constants';
import { RegistryService } from '../../../src/services/registry-service';
import { RubyGemsService } from '../../../src/services/rubygems-service';
import {
    NOKOGIRI_GEM_FIXTURE,
    NOKOGIRI_VERSIONS_FIXTURE,
    RACK_GEM_FIXTURE,
    RACK_OWNERS_FIXTURE,
    RACK_REVERSE_DEPENDENCIES_FIXTURE,
    RACK_VERSIONS_FIXTURE,
} from '../../fixtures/rubygems-fixtures';

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
            getOwners: jest.fn().mockResolvedValue([]),
            getReverseDependencies: jest.fn().mockResolvedValue([]),
            searchGems: jest.fn().mockResolvedValue([]),
            getAllNames: jest.fn().mockResolvedValue([]),
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
            rubygems: expect.objectContaining({
                rubyregistryid: 'rubygems',
                sourceurl: 'https://rubygems.org',
                packagesurl: 'https://registry.example.com/rubyregistries/rubygems/packages',
            }),
        }));
    });

    test('lists the full catalogue as bounded, exact-total pages from the local names index', async () => {
        const names = ['bootsnap', 'devise', 'faraday', 'nokogiri', 'pg', 'puma', 'rack', 'rails', 'rspec', 'sass', 'sidekiq', 'thor'];
        rubygemsService.getAllNames.mockResolvedValue(names);

        const req = createRequest(`/${GROUP_CONFIG.TYPE}/${GROUP_CONFIG.ID}/packages`, { groupId: GROUP_CONFIG.ID }, { offset: '2', limit: '3' });
        const res = createResponse();

        await registryService.getResources(req, res);

        expect(res.set).toHaveBeenCalledWith('X-Total-Count', String(names.length));
        expect(res.set).toHaveBeenCalledWith('Link', expect.stringContaining('rel="prev"'));
        expect(res.set).toHaveBeenCalledWith('Link', expect.stringContaining('rel="next"'));
        expect(res.json).toHaveBeenCalledWith({
            faraday: expect.objectContaining({ packageid: 'faraday', name: 'faraday' }),
            nokogiri: expect.objectContaining({ packageid: 'nokogiri', name: 'nokogiri' }),
            pg: expect.objectContaining({ packageid: 'pg', name: 'pg' }),
        });
        // Collection entries are identity/addressing skeletons only: no eager upstream fetch per listed name.
        expect(rubygemsService.getGem).not.toHaveBeenCalled();
        expect(rubygemsService.getVersions).not.toHaveBeenCalled();
        const page = (res.json as jest.Mock).mock.calls[0][0] as Record<string, Record<string, unknown>>;
        for (const entry of Object.values(page)) {
            expect(entry).not.toHaveProperty('versionid');
            expect(entry).not.toHaveProperty('versionscount');
            expect(entry).toEqual(expect.objectContaining({
                xid: expect.stringMatching(/^\/rubyregistries\/rubygems\/packages\//),
                self: expect.stringContaining('https://registry.example.com/rubyregistries/rubygems/packages/'),
                epoch: 1,
                createdat: expect.any(String),
                modifiedat: expect.any(String),
                metaurl: expect.stringMatching(/\/meta$/),
                versionsurl: expect.stringMatching(/\/versions$/),
            }));
        }
    });

    test('does not emit a next Link on the final page of the catalogue', async () => {
        rubygemsService.getAllNames.mockResolvedValue(['bootsnap', 'devise', 'faraday']);

        const req = createRequest(`/${GROUP_CONFIG.TYPE}/${GROUP_CONFIG.ID}/packages`, { groupId: GROUP_CONFIG.ID }, { offset: '0', limit: '10' });
        const res = createResponse();

        await registryService.getResources(req, res);

        expect(res.set).toHaveBeenCalledWith('X-Total-Count', '3');
        expect(res.set).not.toHaveBeenCalledWith('Link', expect.stringContaining('rel='));
    });

    test('filter=name=<exact> resolves from the local index without fetching gem metadata', async () => {
        rubygemsService.getAllNames.mockResolvedValue(['rack', 'rails']);

        const req = createRequest(
            `/${GROUP_CONFIG.TYPE}/${GROUP_CONFIG.ID}/packages`,
            { groupId: GROUP_CONFIG.ID },
            { filter: 'name=rack' },
        );
        const res = createResponse();

        await registryService.getResources(req, res);

        expect(res.json).toHaveBeenCalledWith({ rack: expect.objectContaining({ packageid: 'rack' }) });
        expect(res.set).toHaveBeenCalledWith('X-Total-Count', '1');
        expect(rubygemsService.getGem).not.toHaveBeenCalled();
        expect(rubygemsService.searchGems).not.toHaveBeenCalled();
    });

    test('filter=name=<exact> returns an empty collection when the name is absent from the index', async () => {
        rubygemsService.getAllNames.mockResolvedValue(['rack', 'rails']);

        const req = createRequest(
            `/${GROUP_CONFIG.TYPE}/${GROUP_CONFIG.ID}/packages`,
            { groupId: GROUP_CONFIG.ID },
            { filter: 'name=does-not-exist' },
        );
        const res = createResponse();

        await registryService.getResources(req, res);

        expect(res.json).toHaveBeenCalledWith({});
        expect(res.set).toHaveBeenCalledWith('X-Total-Count', '0');
    });

    test('filter=name=<prefix>* matches case-insensitively against the local index without upstream crawling', async () => {
        rubygemsService.getAllNames.mockResolvedValue(['rails', 'rails-dom-testing', 'Rails-Extra', 'trailblazer']);

        const req = createRequest(
            `/${GROUP_CONFIG.TYPE}/${GROUP_CONFIG.ID}/packages`,
            { groupId: GROUP_CONFIG.ID },
            { filter: 'name=rails*', offset: '0', limit: '10' },
        );
        const res = createResponse();

        await registryService.getResources(req, res);

        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            rails: expect.objectContaining({ packageid: 'rails' }),
            'rails-dom-testing': expect.objectContaining({ packageid: 'rails-dom-testing' }),
            'Rails-Extra': expect.objectContaining({ packageid: 'Rails-Extra' }),
        }));
        const payload = (res.json as jest.Mock).mock.calls[0][0] as Record<string, unknown>;
        expect(payload['trailblazer']).toBeUndefined();
        expect(rubygemsService.searchGems).not.toHaveBeenCalled();
        expect(rubygemsService.getGem).not.toHaveBeenCalled();
    });

    test('rejects unsupported filter expressions with HTTP 400 problem details', async () => {
        rubygemsService.getAllNames.mockResolvedValue(['rack']);

        const req = createRequest(
            `/${GROUP_CONFIG.TYPE}/${GROUP_CONFIG.ID}/packages`,
            { groupId: GROUP_CONFIG.ID },
            { filter: 'description=web' },
        );
        const res = createResponse();

        await expect(registryService.getResources(req, res)).rejects.toMatchObject({
            status: 400,
            detail: expect.stringContaining('filter=name='),
        });
    });

    test('free-text search scans the local index and is not limited by the former 499 offset cap', async () => {
        const names = Array.from({ length: 600 }, (_, index) => `rack-plugin-${String(index).padStart(3, '0')}`);
        rubygemsService.getAllNames.mockResolvedValue(names);

        const req = createRequest(
            `/${GROUP_CONFIG.TYPE}/${GROUP_CONFIG.ID}/packages`,
            { groupId: GROUP_CONFIG.ID },
            { search: 'rack-plugin', offset: '550', limit: '10' },
        );
        const res = createResponse();

        await registryService.getResources(req, res);

        expect(res.set).toHaveBeenCalledWith('X-Total-Count', String(names.length));
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            'rack-plugin-550': expect.objectContaining({ packageid: 'rack-plugin-550' }),
            'rack-plugin-559': expect.objectContaining({ packageid: 'rack-plugin-559' }),
        }));
        expect(rubygemsService.searchGems).not.toHaveBeenCalled();
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
            versionsurl: 'https://registry.example.com/rubyregistries/rubygems/packages/rack/versions',
            ancestor: expect.any(String),
            description: RACK_VERSIONS_FIXTURE[0]?.description,
            full_name: 'rack-3.1.0',
        }));
        const call = (res.json as jest.Mock).mock.calls[0][0] as Record<string, unknown>;
        expect(call['versionscount']).toBe(RACK_VERSIONS_FIXTURE.length);
        expect(call['metaurl']).toBe('https://registry.example.com/rubyregistries/rubygems/packages/rack/meta');
        expect(call).not.toHaveProperty('defaultversionurl');
    });

    test('returns spec-conformant resource meta from the canonical snapshot', async () => {
        rubygemsService.getGem.mockResolvedValue(RACK_GEM_FIXTURE);
        rubygemsService.getVersions.mockResolvedValue(RACK_VERSIONS_FIXTURE);
        rubygemsService.getOwners.mockResolvedValue(RACK_OWNERS_FIXTURE);
        rubygemsService.getReverseDependencies.mockResolvedValue(RACK_REVERSE_DEPENDENCIES_FIXTURE);
        const req = createRequest(`/${GROUP_CONFIG.TYPE}/${GROUP_CONFIG.ID}/packages/rack/meta`, { groupId: GROUP_CONFIG.ID, name: 'rack' });
        const res = createResponse();

        await registryService.getMeta(req, res);

        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            packageid: 'rack',
            xid: '/rubyregistries/rubygems/packages/rack/meta',
            readonly: true,
            compatibility: 'none',
            defaultversionid: '3.1.0',
            defaultversionsticky: false,
            downloads: RACK_GEM_FIXTURE.downloads,
            project_uri: RACK_GEM_FIXTURE.project_uri,
            owners: RACK_OWNERS_FIXTURE,
            reverse_dependencies: RACK_REVERSE_DEPENDENCIES_FIXTURE,
        }));
        const meta = (res.json as jest.Mock).mock.calls[0][0] as Record<string, unknown>;
        expect(meta['defaultversionurl']).toContain('/packages/rack/versions/3.1.0');
        expect(meta).not.toHaveProperty('homepage_uri');
    });

    test('includes versionscount when inline=versions is requested', async () => {
        rubygemsService.getGem.mockResolvedValue(RACK_GEM_FIXTURE);
        rubygemsService.getVersions.mockResolvedValue(RACK_VERSIONS_FIXTURE);
        const req = createRequest(`/${GROUP_CONFIG.TYPE}/${GROUP_CONFIG.ID}/packages/rack`, { groupId: GROUP_CONFIG.ID, name: 'rack' }, { inline: 'versions' });
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
        rubygemsService.getOwners.mockResolvedValue(RACK_OWNERS_FIXTURE);
        rubygemsService.getReverseDependencies.mockResolvedValue(RACK_REVERSE_DEPENDENCIES_FIXTURE);

        const groupRes = createResponse();
        await registryService.getGroup(createRequest('/rubyregistries/rubygems', { groupId: GROUP_CONFIG.ID }), groupRes);
        assertGroupConforms(modelData, 'rubyregistries', (groupRes.json as jest.Mock).mock.calls[0][0], 'rubygems.group');

        const resourceRes = createResponse();
        await registryService.getResource(createRequest('/rubyregistries/rubygems/packages/rack', { groupId: GROUP_CONFIG.ID, name: 'rack' }), resourceRes);
        assertResourceConforms(modelData, 'rubyregistries', 'packages', (resourceRes.json as jest.Mock).mock.calls[0][0], 'rubygems.resource');

        const metaRes = createResponse();
        await registryService.getMeta(createRequest('/rubyregistries/rubygems/packages/rack/meta', { groupId: GROUP_CONFIG.ID, name: 'rack' }), metaRes);
        assertMetaConforms(modelData, 'rubyregistries', 'packages', (metaRes.json as jest.Mock).mock.calls[0][0], 'rubygems.meta');

        const versionsRes = createResponse();
        await registryService.getVersions(createRequest('/rubyregistries/rubygems/packages/rack/versions', { groupId: GROUP_CONFIG.ID, name: 'rack' }), versionsRes);
        for (const [id, version] of Object.entries((versionsRes.json as jest.Mock).mock.calls[0][0])) {
            assertVersionConforms(modelData, 'rubyregistries', 'packages', version, `rubygems.version.${id}`);
        }
        const resource = (resourceRes.json as jest.Mock).mock.calls[0][0] as Record<string, unknown>;
        const versions = (versionsRes.json as jest.Mock).mock.calls[0][0] as Record<string, Record<string, unknown>>;
        assertResourceProjectsVersion(modelData, 'rubyregistries', 'packages', resource, versions[String(resource['versionid'])], 'rubygems.resource');
    });

    test('returns version IDs with platform suffixes when needed', async () => {
        rubygemsService.getGem.mockResolvedValue(NOKOGIRI_GEM_FIXTURE);
        rubygemsService.getVersions.mockResolvedValue(NOKOGIRI_VERSIONS_FIXTURE);

        const req = createRequest(`/${GROUP_CONFIG.TYPE}/${GROUP_CONFIG.ID}/packages/nokogiri/versions`, { groupId: GROUP_CONFIG.ID, name: 'nokogiri' });
        const res = createResponse();

        await registryService.getVersions(req, res);

        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            '1.18.0': expect.objectContaining({ platform: 'ruby', ancestor: expect.any(String) }),
            '1.18.0-java': expect.objectContaining({ platform: 'java' }),
            '1.18.0-x86_64-linux': expect.objectContaining({ platform: 'x86_64-linux' }),
            '1.18.0-arm64-darwin': expect.objectContaining({ platform: 'arm64-darwin' }),
        }));
    });

    test('resolves a specific platform build from versionId', async () => {
        rubygemsService.getGem.mockResolvedValue(NOKOGIRI_GEM_FIXTURE);
        rubygemsService.getVersions.mockResolvedValue(NOKOGIRI_VERSIONS_FIXTURE);

        const req = createRequest(`/${GROUP_CONFIG.TYPE}/${GROUP_CONFIG.ID}/packages/nokogiri/versions/1.18.0-arm64-darwin`, { groupId: GROUP_CONFIG.ID, name: 'nokogiri', versionId: '1.18.0-arm64-darwin' });
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
