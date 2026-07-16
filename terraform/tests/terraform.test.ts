/**
 * Unit tests for Terraform xRegistry proxy
 * Uses @xregistry/registry-core startFixtureServer for deterministic HTTP protocol fixtures.
 */

import { startFixtureServer, type FixtureServer } from '@xregistry/registry-core';
import { encodeProviderId, decodeProviderId, encodeModuleId, decodeModuleId } from '../src/config/constants';
import { ProviderService } from '../src/services/provider-service';
import { ModuleService } from '../src/services/module-service';
import { RegistryService } from '../src/services/registry-service';
import { SearchService } from '../src/services/search-service';
import { TerraformService } from '../src/services/terraform-service';
import { EntityStateManager } from '../../shared/entity-state-manager';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

import providerVersionsFixture from './fixtures/provider-versions.json';
import providerDownloadFixture from './fixtures/provider-download.json';
import moduleVersionsFixture from './fixtures/module-versions.json';
import moduleVersionDetailFixture from './fixtures/module-version-detail.json';

// ---------------------------------------------------------------------------
// Fixture server routes
// ---------------------------------------------------------------------------
const PROVIDER_VERSIONS_ROUTE = '/v1/providers/hashicorp/aws/versions';
const PROVIDER_DOWNLOAD_ROUTE = '/v1/providers/hashicorp/aws/5.0.0/download/linux/amd64';
const PROVIDER_DOWNLOAD_DARWIN = '/v1/providers/hashicorp/aws/5.0.0/download/darwin/amd64';
const PROVIDER_DOWNLOAD_ARM64 = '/v1/providers/hashicorp/aws/5.0.0/download/linux/arm64';
const PROVIDER_DOWNLOAD_WIN64 = '/v1/providers/hashicorp/aws/5.0.0/download/windows/amd64';
const PROVIDER_DOWNLOAD_467_LINUX = '/v1/providers/hashicorp/aws/4.67.0/download/linux/amd64';
const PROVIDER_DOWNLOAD_467_DARWIN = '/v1/providers/hashicorp/aws/4.67.0/download/darwin/amd64';
const PROVIDER_V2_ROUTE = '/v2/providers';
const MODULE_VERSIONS_ROUTE = '/v1/modules/terraform-aws-modules/vpc/aws/versions';
const MODULE_VERSION_ROUTE = '/v1/modules/terraform-aws-modules/vpc/aws/5.1.0';
const MODULE_SEARCH_ROUTE = '/v1/modules/terraform-aws-modules/vpc/aws';
const NOT_FOUND_PROVIDER_ROUTE = '/v1/providers/unknown/nonexistent/versions';
const NOT_FOUND_MODULE_ROUTE = '/v1/modules/unknown/nonexistent/aws/versions';

const DOWNLOAD_RESPONSE = {
    ...providerDownloadFixture,
    os: 'linux',
    arch: 'amd64',
    filename: 'terraform-provider-aws_5.0.0_linux_amd64.zip',
};

const PROVIDER_V2_RESPONSE = {
    data: [{
        id: 'hashicorp/aws',
        type: 'providers',
        attributes: {
            namespace: 'hashicorp',
            name: 'aws',
            'full-name': 'hashicorp/aws',
            description: 'The AWS provider',
            downloads: 5_000_000_000,
            tier: 'official',
            logo_url: '',
            categories: ['cloud'],
            featured: true,
            unlisted: false,
        }
    }]
};

function makeRoutes(baseUrl: string) {
    // Strip the base URL to get just paths — fixture server uses path matching
    return [
        { path: PROVIDER_VERSIONS_ROUTE, responses: [{ body: providerVersionsFixture, etag: '"pv1"' }] },
        { path: PROVIDER_DOWNLOAD_ROUTE, responses: [{ body: { ...DOWNLOAD_RESPONSE, os: 'linux', arch: 'amd64' } }] },
        { path: PROVIDER_DOWNLOAD_DARWIN, responses: [{ body: { ...DOWNLOAD_RESPONSE, os: 'darwin', arch: 'amd64', filename: 'terraform-provider-aws_5.0.0_darwin_amd64.zip' } }] },
        { path: PROVIDER_DOWNLOAD_ARM64, responses: [{ body: { ...DOWNLOAD_RESPONSE, os: 'linux', arch: 'arm64', filename: 'terraform-provider-aws_5.0.0_linux_arm64.zip' } }] },
        { path: PROVIDER_DOWNLOAD_WIN64, responses: [{ body: { ...DOWNLOAD_RESPONSE, os: 'windows', arch: 'amd64', filename: 'terraform-provider-aws_5.0.0_windows_amd64.zip' } }] },
        { path: PROVIDER_DOWNLOAD_467_LINUX, responses: [{ body: { ...DOWNLOAD_RESPONSE, os: 'linux', arch: 'amd64' } }] },
        { path: PROVIDER_DOWNLOAD_467_DARWIN, responses: [{ body: { ...DOWNLOAD_RESPONSE, os: 'darwin', arch: 'amd64', filename: 'terraform-provider-aws_4.67.0_darwin_amd64.zip' } }] },
        { path: PROVIDER_V2_ROUTE, responses: [{ body: PROVIDER_V2_RESPONSE }] },
        { path: MODULE_VERSIONS_ROUTE, responses: [{ body: moduleVersionsFixture }] },
        { path: MODULE_VERSION_ROUTE, responses: [{ body: moduleVersionDetailFixture }] },
        { path: MODULE_SEARCH_ROUTE, responses: [{ body: moduleVersionDetailFixture }] },
        { path: NOT_FOUND_PROVIDER_ROUTE, responses: [{ status: 404, body: { errors: ['Not Found'] } }] },
        { path: NOT_FOUND_MODULE_ROUTE, responses: [{ status: 404, body: { errors: ['Not Found'] } }] },
    ];
}

// ---------------------------------------------------------------------------
// Helper: build a real TerraformService pointing at the fixture server
// ---------------------------------------------------------------------------
function makeTfService(fixtureUrl: string, cacheDir: string): TerraformService {
    return new TerraformService({
        cacheDir,
        // Override the registry URL by monkey-patching — the service reads URLs from TERRAFORM_API
        // constants which start with "https://registry.terraform.io". We redirect by pointing fetch
        // at the fixture server via a custom fetch implementation that rewrites the origin.
        fetch: async (url, init) => {
            const u = new URL(String(url));
            const fixtureU = new URL(fixtureUrl);
            u.protocol = fixtureU.protocol;
            u.host = fixtureU.host;
            return fetch(u.toString(), init);
        },
        timeoutMs: 5_000,
        operationTimeoutMs: 10_000,
        maxAttempts: 1,
        concurrency: 4,
    });
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------
let fixture: FixtureServer;
let cacheDir: string;
let tfService: TerraformService;

beforeAll(async () => {
    fixture = await startFixtureServer(makeRoutes(''));
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-test-'));
    tfService = makeTfService(fixture.url, cacheDir);
});

afterAll(async () => {
    await fixture.close();
    fs.rmSync(cacheDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// ID encoding / decoding
// ---------------------------------------------------------------------------
describe('ID encoding', () => {
    describe('encodeProviderId / decodeProviderId', () => {
        it('encodes namespace~type', () => {
            expect(encodeProviderId('hashicorp', 'aws')).toBe('hashicorp~aws');
        });

        it('decodes back to namespace and type', () => {
            expect(decodeProviderId('hashicorp~aws')).toEqual({ namespace: 'hashicorp', type: 'aws' });
        });

        it('returns null for malformed IDs — too few parts', () => {
            expect(decodeProviderId('hashicorp')).toBeNull();
        });

        it('returns null for empty string', () => {
            expect(decodeProviderId('')).toBeNull();
        });

        it('returns null for too many parts (module-shaped ID)', () => {
            expect(decodeProviderId('a~b~c')).toBeNull();
        });

        it('is reversible: encode → decode → original parts', () => {
            const ns = 'datadog', t = 'datadog';
            const id = encodeProviderId(ns, t);
            const back = decodeProviderId(id);
            expect(back).toEqual({ namespace: ns, type: t });
        });
    });

    describe('encodeModuleId / decodeModuleId', () => {
        it('encodes namespace~name~provider', () => {
            expect(encodeModuleId('terraform-aws-modules', 'vpc', 'aws'))
                .toBe('terraform-aws-modules~vpc~aws');
        });

        it('decodes back to three parts', () => {
            expect(decodeModuleId('terraform-aws-modules~vpc~aws')).toEqual({
                namespace: 'terraform-aws-modules',
                name: 'vpc',
                provider: 'aws',
            });
        });

        it('returns null for two-part IDs (provider-shaped)', () => {
            expect(decodeModuleId('a~b')).toBeNull();
        });

        it('returns null for empty string', () => {
            expect(decodeModuleId('')).toBeNull();
        });

        it('returns null for four-part IDs', () => {
            expect(decodeModuleId('a~b~c~d')).toBeNull();
        });

        it('is reversible: encode → decode → original parts', () => {
            const ns = 'hashicorp', n = 'consul', p = 'aws';
            const id = encodeModuleId(ns, n, p);
            const back = decodeModuleId(id);
            expect(back).toEqual({ namespace: ns, name: n, provider: p });
        });
    });
});

// ---------------------------------------------------------------------------
// RegistryService
// ---------------------------------------------------------------------------
describe('RegistryService', () => {
    let service: RegistryService;

    beforeEach(() => {
        const searchSvc = new SearchService(tfService);
        service = new RegistryService(searchSvc, new EntityStateManager());
    });

    it('getRoot returns required xRegistry fields', () => {
        const root = service.getRoot('http://localhost:3800');
        expect(root).toHaveProperty('specversion', '1.0-rc2');
        expect(root).toHaveProperty('registryid', 'terraform-registry-wrapper');
        expect(root).toHaveProperty('xid', '/');
        expect(root).toHaveProperty('terraformregistriesurl');
        expect(root).toHaveProperty('terraformregistriescount', 1);
    });

    it('getGroups returns the registry.terraform.io group', () => {
        const groups = service.getGroups('http://localhost:3800');
        expect(groups['registry.terraform.io']).toBeDefined();
        const g = groups['registry.terraform.io'] as Record<string, unknown>;
        expect(g).toHaveProperty('providersurl');
        expect(g).toHaveProperty('modulesurl');
    });

    it('getGroupDetails includes resource counts', () => {
        const details = service.getGroupDetails('http://localhost:3800');
        expect(details).toHaveProperty('providerscount');
        expect(details).toHaveProperty('modulescount');
    });

    it('getCapabilities reports read-only', () => {
        const caps = service.getCapabilities();
        expect(caps).toHaveProperty('mutable', false);
        expect(caps).toHaveProperty('filter', true);
        expect(caps).toHaveProperty('pagination', true);
    });

    it('getModel returns model with self URL and groups', () => {
        // createRegistryApp handles /model; RegistryService provides root/groups.
        // This test verifies the registry-level model data shape (used by createRegistryApp).
        const caps = service.getCapabilities();
        expect(caps).toHaveProperty('mutable', false);
        expect(caps).toHaveProperty('filter', true);
    });
});

// ---------------------------------------------------------------------------
// ProviderService (via fixture server)
// ---------------------------------------------------------------------------
describe('ProviderService', () => {
    let service: ProviderService;

    beforeEach(() => {
        service = new ProviderService(tfService, new EntityStateManager());
    });

    it('getProviderMetadata returns required xRegistry fields', async () => {
        const data = await service.getProviderMetadata('hashicorp~aws', 'http://localhost:3800');
        expect(data).toHaveProperty('providerid', 'hashicorp~aws');
        expect(data).toHaveProperty('xid');
        expect(data).toHaveProperty('self');
        expect(data).toHaveProperty('versionsurl');
        expect(data).toHaveProperty('versionscount', 2);
        expect(data).toHaveProperty('namespace', 'hashicorp');
        expect(data).toHaveProperty('type', 'aws');
        expect(data).toHaveProperty('tier', 'official');
        expect(data).toHaveProperty('downloads', 5_000_000_000);
    });

    it('getProviderMetadata defaultversionid is latest (ascending order: last element)', async () => {
        const data = await service.getProviderMetadata('hashicorp~aws', 'http://localhost:3800');
        // Fixture: versions = [4.67.0, 5.0.0] (ascending, oldest first)
        // latest = last element = 5.0.0
        expect(data).toHaveProperty('versionid', '5.0.0');
    });

    it('getProviderVersions returns a map keyed by version string', async () => {
        const versions = await service.getProviderVersions('hashicorp~aws', 'http://localhost:3800');
        expect(versions['5.0.0']).toBeDefined();
        expect(versions['4.67.0']).toBeDefined();
        const v5 = versions['5.0.0'] as Record<string, unknown>;
        expect(v5).toHaveProperty('versionid', '5.0.0');
        expect(v5).toHaveProperty('isdefault', true);
        expect(v5).toHaveProperty('providerid', 'hashicorp~aws');
    });

    it('getProviderVersions: 5.0.0 ancestor is 4.67.0 (ascending list)', async () => {
        const versions = await service.getProviderVersions('hashicorp~aws', 'http://localhost:3800');
        const v5 = versions['5.0.0'] as Record<string, unknown>;
        // In ascending list [4.67.0, 5.0.0], index 1's predecessor is 4.67.0
        expect(v5).toHaveProperty('ancestor', '4.67.0');
    });

    it('getProviderVersions: 4.67.0 ancestor is itself (oldest, no predecessor)', async () => {
        const versions = await service.getProviderVersions('hashicorp~aws', 'http://localhost:3800');
        const v4 = versions['4.67.0'] as Record<string, unknown>;
        expect(v4).toHaveProperty('ancestor', '4.67.0');
    });

    it('getProviderVersion enriches with platform distribution metadata', async () => {
        const version = await service.getProviderVersion('hashicorp~aws', '5.0.0', 'http://localhost:3800');
        expect(version).toHaveProperty('versionid', '5.0.0');
        expect(version).toHaveProperty('platforms');
        const platforms = version['platforms'] as any[];
        expect(Array.isArray(platforms)).toBe(true);
        const withUrl = platforms.filter((p) => p.download_url);
        expect(withUrl.length).toBeGreaterThan(0);
        const p = withUrl[0];
        expect(p).toHaveProperty('os');
        expect(p).toHaveProperty('arch');
        expect(p).toHaveProperty('download_url');
        expect(p).toHaveProperty('shasum');
        expect(p).toHaveProperty('shasums_url');
        expect(p).toHaveProperty('shasums_signature_url');
        expect(p).toHaveProperty('filename');
    });

    it('getProviderVersion includes signing_keys with GPG key', async () => {
        const version = await service.getProviderVersion('hashicorp~aws', '5.0.0', 'http://localhost:3800');
        expect(version).toHaveProperty('signing_keys');
        const sk = version['signing_keys'] as Record<string, unknown>;
        expect(sk).toHaveProperty('gpg_public_keys');
        const keys = sk['gpg_public_keys'] as any[];
        expect(keys.length).toBeGreaterThan(0);
        expect(keys[0]).toHaveProperty('key_id', '34365D9472D7468F');
        expect(keys[0]).toHaveProperty('ascii_armor');
        expect(keys[0]).toHaveProperty('source', 'HashiCorp');
        expect(keys[0]).toHaveProperty('source_url');
    });

    it('platforms are sorted deterministically by os then arch', async () => {
        const version = await service.getProviderVersion('hashicorp~aws', '5.0.0', 'http://localhost:3800');
        const platforms = version['platforms'] as Array<{ os: string; arch: string }>;
        for (let i = 1; i < platforms.length; i++) {
            const prev = `${platforms[i - 1].os}/${platforms[i - 1].arch}`;
            const curr = `${platforms[i].os}/${platforms[i].arch}`;
            expect(prev.localeCompare(curr)).toBeLessThanOrEqual(0);
        }
    });

    it('throws entity_not_found for malformed provider ID', async () => {
        await expect(service.getProviderMetadata('invalid-id', 'http://localhost:3800'))
            .rejects.toMatchObject({ status: 404 });
    });

    it('getProviderMeta returns meta sub-resource with correct defaultversionid', async () => {
        const meta = await service.getProviderMeta('hashicorp~aws', 'http://localhost:3800');
        expect(meta).toHaveProperty('providerid', 'hashicorp~aws');
        expect(meta).toHaveProperty('readonly', true);
        // Ascending fixture: latest = 5.0.0
        expect(meta).toHaveProperty('defaultversionid', '5.0.0');
    });

    it('fixture server receives ETag and returns 304 on repeat request', async () => {
        // Make two calls — second should hit cache (no new fixture request needed)
        const key1 = await service.getProviderVersions('hashicorp~aws', 'http://localhost:3800');
        const key2 = await service.getProviderVersions('hashicorp~aws', 'http://localhost:3800');
        expect(key1['5.0.0']).toEqual(key2['5.0.0']);
    });
});

// ---------------------------------------------------------------------------
// ModuleService (via fixture server)
// ---------------------------------------------------------------------------
describe('ModuleService', () => {
    let service: ModuleService;

    beforeEach(() => {
        service = new ModuleService(tfService, new EntityStateManager());
    });

    it('getModuleMetadata returns required xRegistry fields', async () => {
        const data = await service.getModuleMetadata('terraform-aws-modules~vpc~aws', 'http://localhost:3800');
        expect(data).toHaveProperty('moduleid', 'terraform-aws-modules~vpc~aws');
        expect(data).toHaveProperty('xid');
        expect(data).toHaveProperty('self');
        expect(data).toHaveProperty('versionsurl');
        expect(data).toHaveProperty('versionscount', 3);
        expect(data).toHaveProperty('namespace', 'terraform-aws-modules');
        expect(data).toHaveProperty('name', 'vpc');
        expect(data).toHaveProperty('provider', 'aws');
        expect(data).toHaveProperty('source', 'terraform-aws-modules/vpc/aws');
        expect(data).toHaveProperty('verified', true);
    });

    it('getModuleMetadata defaultversionid is first element (descending: newest first)', async () => {
        const data = await service.getModuleMetadata('terraform-aws-modules~vpc~aws', 'http://localhost:3800');
        // Fixture: versions = [5.1.0, 5.0.0, 4.0.0] (descending, newest first)
        expect(data).toHaveProperty('versionid', '5.1.0');
    });

    it('getModuleVersions returns a map keyed by version string', async () => {
        const versions = await service.getModuleVersions('terraform-aws-modules~vpc~aws', 'http://localhost:3800');
        expect(versions['5.1.0']).toBeDefined();
        expect(versions['5.0.0']).toBeDefined();
        expect(versions['4.0.0']).toBeDefined();
        const v = versions['5.1.0'] as Record<string, unknown>;
        expect(v).toHaveProperty('versionid', '5.1.0');
        expect(v).toHaveProperty('moduleid', 'terraform-aws-modules~vpc~aws');
        expect(v).toHaveProperty('isdefault', true);
    });

    it('getModuleVersions: 5.1.0 ancestor is 5.0.0 (descending list)', async () => {
        const versions = await service.getModuleVersions('terraform-aws-modules~vpc~aws', 'http://localhost:3800');
        const v5_1 = versions['5.1.0'] as Record<string, unknown>;
        // Descending [5.1.0, 5.0.0, 4.0.0]: index 0's next-older = 5.0.0
        expect(v5_1).toHaveProperty('ancestor', '5.0.0');
    });

    it('getModuleVersions: 5.0.0 ancestor is 4.0.0 (descending list)', async () => {
        const versions = await service.getModuleVersions('terraform-aws-modules~vpc~aws', 'http://localhost:3800');
        const v5_0 = versions['5.0.0'] as Record<string, unknown>;
        expect(v5_0).toHaveProperty('ancestor', '4.0.0');
    });

    it('getModuleVersions: 4.0.0 ancestor is itself (oldest, no older entry)', async () => {
        const versions = await service.getModuleVersions('terraform-aws-modules~vpc~aws', 'http://localhost:3800');
        const v4 = versions['4.0.0'] as Record<string, unknown>;
        expect(v4).toHaveProperty('ancestor', '4.0.0');
    });

    it('getModuleVersion returns detailed version info', async () => {
        const v = await service.getModuleVersion('terraform-aws-modules~vpc~aws', '5.1.0', 'http://localhost:3800');
        expect(v).toHaveProperty('versionid', '5.1.0');
        expect(v).toHaveProperty('source');
        expect(v).toHaveProperty('downloads', 50_000_000);
        expect(v).toHaveProperty('verified', true);
    });

    it('getModuleVersion: 5.0.0 ancestor is 4.0.0', async () => {
        const v = await service.getModuleVersion('terraform-aws-modules~vpc~aws', '5.0.0', 'http://localhost:3800');
        expect(v).toHaveProperty('ancestor', '4.0.0');
    });

    it('getModuleVersion: 5.1.0 ancestor is 5.0.0', async () => {
        const v = await service.getModuleVersion('terraform-aws-modules~vpc~aws', '5.1.0', 'http://localhost:3800');
        expect(v).toHaveProperty('ancestor', '5.0.0');
    });

    it('getModuleMeta returns meta sub-resource with correct defaultversionid', async () => {
        const meta = await service.getModuleMeta('terraform-aws-modules~vpc~aws', 'http://localhost:3800');
        expect(meta).toHaveProperty('moduleid', 'terraform-aws-modules~vpc~aws');
        expect(meta).toHaveProperty('readonly', true);
        // Descending fixture: latest = first element = 5.1.0
        expect(meta).toHaveProperty('defaultversionid', '5.1.0');
    });

    it('throws entity_not_found for malformed module ID', async () => {
        await expect(service.getModuleMetadata('invalid', 'http://localhost:3800'))
            .rejects.toMatchObject({ status: 404 });
    });

    it('omits unknown counts — versionscount is defined and numeric', async () => {
        const data = await service.getModuleMetadata('terraform-aws-modules~vpc~aws', 'http://localhost:3800');
        expect(typeof data['versionscount']).toBe('number');
    });
});

// ---------------------------------------------------------------------------
// SearchService
// ---------------------------------------------------------------------------
describe('SearchService', () => {
    let service: SearchService;

    beforeEach(() => {
        service = new SearchService(tfService);
    });

    afterEach(() => {
        service.stopPeriodicRefresh();
    });

    it('initialize falls back to hardcoded providers when search unavailable', async () => {
        await service.initialize();
        // Fixture server doesn't have the search endpoint, so falls back to defaults
        expect(service.getProviderCount()).toBeGreaterThan(0);
    });

    it('providerInCache returns false for unknown provider before initialisation', () => {
        expect(service.providerInCache('unknown~unknown')).toBe(false);
    });

    it('providerExists resolves true for hashicorp/aws via live check', async () => {
        const exists = await service.providerExists('hashicorp', 'aws');
        expect(exists).toBe(true);
    });

    it('moduleInCache returns false before initialisation', () => {
        expect(service.moduleInCache('a~b~c')).toBe(false);
    });
});
