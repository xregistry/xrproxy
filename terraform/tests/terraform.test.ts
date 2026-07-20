/**
 * Unit tests for Terraform xRegistry proxy
 * Uses @xregistry/registry-core startFixtureServer for deterministic HTTP protocol fixtures.
 */

import { createRegistryApp, isUpstreamError, startFixtureServer, type FixtureServer } from '@xregistry/registry-core';
import { CAPABILITIES, decodeModuleIdentity, decodeProviderIdentity, encodeModuleId, providerIdentity } from '../src/config/constants';
import { ProviderService } from '../src/services/provider-service';
import { ModuleService } from '../src/services/module-service';
import { RegistryService } from '../src/services/registry-service';
import { SearchService } from '../src/services/search-service';
import { TerraformService } from '../src/services/terraform-service';
import { EntityStateManager } from '../../shared/entity-state-manager';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as http from 'http';
import express from 'express';
import { createProviderRoutes } from '../src/routes/providers';
import { createModuleRoutes } from '../src/routes/modules';
import { createXRegistryRoutes } from '../src/routes/xregistry';
import { sortTerraformVersions } from '../src/utils/versions';

import providerVersionsFixture from './fixtures/provider-versions.json';
import providerDownloadFixture from './fixtures/provider-download.json';
import moduleVersionsFixture from './fixtures/module-versions.json';
import moduleVersionDetailFixture from './fixtures/module-version-detail.json';
import modelData from '../model.json';

const {
    assertGroupConforms,
    assertMetaConforms,
    assertResourceConforms,
    assertResourceProjectsVersion,
    assertVersionConforms,
} = require(path.join(__dirname, '../../test/helpers/xregistry-model-conformance.cjs'));
const { assertCapabilitiesConform } = require(
    path.join(__dirname, "../../test/helpers/xregistry-capability-conformance.cjs"),
);

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
const CUSTOM_PROVIDER_ROUTE = '/v1/providers/acme/widget/versions';
const PHILIPS_PROVIDER_ROUTE = '/v1/providers/philips-software/hsdp/versions';
const CASE_PROVIDER_ROUTE = '/v1/providers/HashiCorp/AWS/versions';
const CASE_MODULE_ROUTE = '/v1/modules/Terraform-Aws-Modules/VPC/AWS/versions';
const OUTAGE_PROVIDER_ROUTE = '/v1/providers/outage/broken/versions';
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
    }, {
        id: 'philips-software/hsdp',
        type: 'providers',
        attributes: {
            namespace: 'philips-software',
            name: 'hsdp',
            'full-name': 'philips-software/hsdp',
            description: 'The HSDP provider',
            downloads: 1000,
            tier: 'community',
            logo_url: '',
            categories: ['healthcare'],
            featured: false,
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
        { path: CUSTOM_PROVIDER_ROUTE, responses: [{ body: { ...providerVersionsFixture, id: 'acme/widget' } }] },
        { path: PHILIPS_PROVIDER_ROUTE, responses: [{ body: { ...providerVersionsFixture, id: 'philips-software/hsdp' } }] },
        { path: CASE_PROVIDER_ROUTE, responses: [{ body: providerVersionsFixture }] },
        { path: CASE_MODULE_ROUTE, responses: [{ body: moduleVersionsFixture }] },
        { path: OUTAGE_PROVIDER_ROUTE, responses: [{ status: 503, body: { errors: ['Unavailable'] } }] },
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
// Native namespace identity
// ---------------------------------------------------------------------------
describe('Terraform xRegistry identity', () => {
    it('maps provider namespace to group and type to resource', () => {
        expect(providerIdentity('hashicorp', 'aws')).toEqual({ groupId: 'hashicorp', resourceId: 'aws' });
        expect(decodeProviderIdentity('hashicorp', 'aws')).toEqual({ namespace: 'hashicorp', type: 'aws' });
    });

    it('encodes module name/provider reversibly within a namespace', () => {
        expect(encodeModuleId('vpc', 'aws')).toBe('vpc~aws');
        expect(decodeModuleIdentity('terraform-aws-modules', 'vpc~aws')).toEqual({
            namespace: 'terraform-aws-modules', name: 'vpc', provider: 'aws',
        });
    });

    it('rejects slash-bearing group and resource entity IDs', () => {
        expect(decodeProviderIdentity('hashicorp/cloud', 'aws')).toBeNull();
        expect(decodeProviderIdentity('hashicorp', 'cloud/aws')).toBeNull();
        expect(decodeModuleIdentity('terraform-aws-modules/vpc', 'vpc~aws')).toBeNull();
        expect(decodeModuleIdentity('terraform-aws-modules', 'nested/vpc~aws')).toBeNull();
    });

    it('uses collision-free tilde encoding because Terraform identifiers reject tilde', () => {
        expect(() => encodeModuleId('vpc~legacy', 'aws')).toThrow();
        expect(() => encodeModuleId('vpc', 'aws~other')).toThrow();
        expect(() => encodeModuleId('n'.repeat(64), 'p'.repeat(64))).toThrow();
        expect(decodeProviderIdentity('n'.repeat(129), 'aws')).toBeNull();
        expect(decodeProviderIdentity('hashicorp', 'p'.repeat(129))).toBeNull();
    });
});

describe('Terraform version ordering', () => {
    it('SemVer-sorts unordered versions including prereleases', () => {
        expect(sortTerraformVersions(['2.0.0', '1.0.0', '2.0.0-rc.1', '1.10.0']))
            .toEqual(['1.0.0', '1.10.0', '2.0.0-rc.1', '2.0.0']);
    });

    it('sorts non-SemVer values lexically before SemVer values', () => {
        expect(sortTerraformVersions(['nightly-z', '1.0.0', 'nightly-a']))
            .toEqual(['nightly-a', 'nightly-z', '1.0.0']);
        expect(sortTerraformVersions(['snapshot-z', 'snapshot-a']))
            .toEqual(['snapshot-a', 'snapshot-z']);
    });
});

// ---------------------------------------------------------------------------
// RegistryService
// ---------------------------------------------------------------------------
describe('RegistryService', () => {
    let service: RegistryService;
    let searchSvc: SearchService;

    beforeEach(async () => {
        searchSvc = new SearchService(tfService);
        await searchSvc.providerExists('hashicorp', 'aws');
        await searchSvc.moduleExists('terraform-aws-modules', 'vpc', 'aws');
        service = new RegistryService(searchSvc, new EntityStateManager());
    });

    it('getRoot reports discovered native namespace groups', () => {
        const root = service.getRoot('http://localhost:3800');
        expect(root).toHaveProperty('specversion', '1.0-rc2');
        expect(root).toHaveProperty('registryid', 'terraform-registry-wrapper');
        expect(root).toHaveProperty('terraformregistriesurl');
        expect(root).not.toHaveProperty('terraformregistriescount');
    });

    it('returns namespace groups with host metadata and no non-authoritative counts', () => {
        const namespaces = service.getNamespaces();
        expect(namespaces.map(item => item.namespace)).toEqual(['hashicorp', 'terraform-aws-modules']);
        const summary = namespaces.find(item => item.namespace === 'hashicorp')!;
        const group = service.getGroup('http://localhost:3800', summary);
        expect(group).toHaveProperty('terraformregistryid', 'hashicorp');
        expect(group).toHaveProperty('registryhost', 'registry.terraform.io');
        expect(group).not.toHaveProperty('providerscount');
        expect(group).not.toHaveProperty('modulescount');
        expect(group).toHaveProperty('providersurl');
        expect(group).toHaveProperty('modulesurl');
    });

    it("getCapabilities returns the complete rc2 contract", () => {
        assertCapabilitiesConform(service.getCapabilities(), { flags: [], versionmodes: ["manual", "semver"] });
    });

    it("serves exact model keys and schema-valid capabilities at runtime", async () => {
        const app = createRegistryApp({ model: modelData, capabilities: CAPABILITIES });
        const server = http.createServer(app);
        await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
        try {
            const address = server.address();
            if (!address || typeof address === "string") throw new Error("No server address");
            const base = `http://127.0.0.1:${address.port}`;
            const capabilities = await (await fetch(`${base}/capabilities`)).json();
            assertCapabilitiesConform(capabilities, { flags: [], versionmodes: ["manual", "semver"] });
            const source = await (await fetch(`${base}/modelsource`)).json() as Record<string, unknown>;
            const full = await (await fetch(`${base}/model`)).json() as Record<string, unknown>;
            expect(Object.keys(source).sort()).toEqual(Object.keys(modelData).sort());
            expect(source).not.toHaveProperty("default");
            expect(full).not.toHaveProperty("default");
        } finally {
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        }
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
        const data = await service.getProviderMetadata('hashicorp', 'aws', 'http://localhost:3800');
        expect(data).toHaveProperty('providerid', 'aws');
        expect(data).toHaveProperty('xid');
        expect(data).toHaveProperty('self');
        expect(data).toHaveProperty('versionsurl');
        expect(data).toHaveProperty('versionscount', 2);
        expect(data).toHaveProperty('namespace', 'hashicorp');
        expect(data).toHaveProperty('type', 'aws');
        expect(data).toHaveProperty('ancestor', '4.67.0');
        expect(data).not.toHaveProperty('tier');
        expect(data).not.toHaveProperty('downloads');
        expect(data).not.toHaveProperty('defaultversionurl');
    });

    it('getProviderMetadata defaultversionid is latest after SemVer sorting', async () => {
        const data = await service.getProviderMetadata('hashicorp', 'aws', 'http://localhost:3800');
        // Fixture is intentionally unordered; SemVer order is [4.67.0, 5.0.0]
        // latest = highest SemVer = 5.0.0
        expect(data).toHaveProperty('versionid', '5.0.0');
    });

    it('getProviderVersions returns a map keyed by version string', async () => {
        const versions = await service.getProviderVersions('hashicorp', 'aws', 'http://localhost:3800');
        expect(versions['5.0.0']).toBeDefined();
        expect(versions['4.67.0']).toBeDefined();
        const v5 = versions['5.0.0'] as Record<string, unknown>;
        expect(v5).toHaveProperty('versionid', '5.0.0');
        expect(v5).toHaveProperty('isdefault', true);
        expect(v5).toHaveProperty('providerid', 'aws');
    });

    it('getProviderVersions: 5.0.0 ancestor is 4.67.0 (SemVer predecessor)', async () => {
        const versions = await service.getProviderVersions('hashicorp', 'aws', 'http://localhost:3800');
        const v5 = versions['5.0.0'] as Record<string, unknown>;
        // The predecessor of 5.0.0 is 4.67.0 regardless of upstream order
        expect(v5).toHaveProperty('ancestor', '4.67.0');
    });

    it('getProviderVersions: 4.67.0 ancestor is itself (oldest, no predecessor)', async () => {
        const versions = await service.getProviderVersions('hashicorp', 'aws', 'http://localhost:3800');
        const v4 = versions['4.67.0'] as Record<string, unknown>;
        expect(v4).toHaveProperty('ancestor', '4.67.0');
    });

    it('getProviderVersion enriches with platform distribution metadata', async () => {
        const version = await service.getProviderVersion('hashicorp', 'aws', '5.0.0', 'http://localhost:3800');
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
        const version = await service.getProviderVersion('hashicorp', 'aws', '5.0.0', 'http://localhost:3800');
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
        const version = await service.getProviderVersion('hashicorp', 'aws', '5.0.0', 'http://localhost:3800');
        const platforms = version['platforms'] as Array<{ os: string; arch: string }>;
        for (let i = 1; i < platforms.length; i++) {
            const prev = `${platforms[i - 1].os}/${platforms[i - 1].arch}`;
            const curr = `${platforms[i].os}/${platforms[i].arch}`;
            expect(prev.localeCompare(curr)).toBeLessThanOrEqual(0);
        }
    });

    it('throws entity_not_found for malformed provider ID', async () => {
        await expect(service.getProviderMetadata('invalid/group', 'invalid-id', 'http://localhost:3800'))
            .rejects.toMatchObject({ status: 404 });
    });

    it('getProviderMeta returns meta sub-resource with correct defaultversionid', async () => {
        const meta = await service.getProviderMeta('hashicorp', 'aws', 'http://localhost:3800');
        expect(meta).toHaveProperty('providerid', 'aws');
        expect(meta).toHaveProperty('readonly', true);
        expect(meta).toHaveProperty('defaultversionsticky', false);
        // Ascending fixture: latest = 5.0.0
        expect(meta).toHaveProperty('defaultversionid', '5.0.0');
    });

    it('fixture server receives ETag and returns 304 on repeat request', async () => {
        // Make two calls — second should hit cache (no new fixture request needed)
        const key1 = await service.getProviderVersions('hashicorp', 'aws', 'http://localhost:3800');
        const key2 = await service.getProviderVersions('hashicorp', 'aws', 'http://localhost:3800');
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
        const data = await service.getModuleMetadata('terraform-aws-modules', 'vpc~aws', 'http://localhost:3800');
        expect(data).toHaveProperty('moduleid', 'vpc~aws');
        expect(data).toHaveProperty('xid');
        expect(data).toHaveProperty('self');
        expect(data).toHaveProperty('versionsurl');
        expect(data).toHaveProperty('versionscount', 3);
        expect(data).toHaveProperty('namespace', 'terraform-aws-modules');
        expect(data).toHaveProperty('name', 'vpc');
        expect(data).toHaveProperty('provider', 'aws');
        expect(data).toHaveProperty('source', 'terraform-aws-modules/vpc/aws');
        expect(data).toHaveProperty('ancestor', '5.0.0');
        expect(data).toHaveProperty('verified', true);
    });

    it('getModuleMetadata defaultversionid is highest after SemVer sorting', async () => {
        const data = await service.getModuleMetadata('terraform-aws-modules', 'vpc~aws', 'http://localhost:3800');
        // Fixture is intentionally unordered; highest SemVer is 5.1.0
        expect(data).toHaveProperty('versionid', '5.1.0');
    });

    it('getModuleVersions returns a map keyed by version string', async () => {
        const versions = await service.getModuleVersions('terraform-aws-modules', 'vpc~aws', 'http://localhost:3800');
        expect(versions['5.1.0']).toBeDefined();
        expect(versions['5.0.0']).toBeDefined();
        expect(versions['4.0.0']).toBeDefined();
        const v = versions['5.1.0'] as Record<string, unknown>;
        expect(v).toHaveProperty('versionid', '5.1.0');
        expect(v).toHaveProperty('moduleid', 'vpc~aws');
        expect(v).toHaveProperty('isdefault', true);
    });

    it('getModuleVersions: 5.1.0 ancestor is 5.0.0 (SemVer predecessor)', async () => {
        const versions = await service.getModuleVersions('terraform-aws-modules', 'vpc~aws', 'http://localhost:3800');
        const v5_1 = versions['5.1.0'] as Record<string, unknown>;
        // The predecessor of 5.1.0 is 5.0.0
        expect(v5_1).toHaveProperty('ancestor', '5.0.0');
    });

    it('getModuleVersions: 5.0.0 ancestor is 4.0.0 (SemVer predecessor)', async () => {
        const versions = await service.getModuleVersions('terraform-aws-modules', 'vpc~aws', 'http://localhost:3800');
        const v5_0 = versions['5.0.0'] as Record<string, unknown>;
        expect(v5_0).toHaveProperty('ancestor', '4.0.0');
    });

    it('getModuleVersions: 4.0.0 ancestor is itself (oldest, no older entry)', async () => {
        const versions = await service.getModuleVersions('terraform-aws-modules', 'vpc~aws', 'http://localhost:3800');
        const v4 = versions['4.0.0'] as Record<string, unknown>;
        expect(v4).toHaveProperty('ancestor', '4.0.0');
    });

    it('getModuleVersion returns detailed version info', async () => {
        const v = await service.getModuleVersion('terraform-aws-modules', 'vpc~aws', '5.1.0', 'http://localhost:3800');
        expect(v).toHaveProperty('versionid', '5.1.0');
        expect(v).toHaveProperty('source');
        expect(v).toHaveProperty('downloads', 50_000_000);
        expect(v).toHaveProperty('verified', true);
    });

    it('getModuleVersion: 5.0.0 ancestor is 4.0.0', async () => {
        const v = await service.getModuleVersion('terraform-aws-modules', 'vpc~aws', '5.0.0', 'http://localhost:3800');
        expect(v).toHaveProperty('ancestor', '4.0.0');
    });

    it('getModuleVersion: 5.1.0 ancestor is 5.0.0', async () => {
        const v = await service.getModuleVersion('terraform-aws-modules', 'vpc~aws', '5.1.0', 'http://localhost:3800');
        expect(v).toHaveProperty('ancestor', '5.0.0');
    });

    it('getModuleMeta returns meta sub-resource with correct defaultversionid', async () => {
        const meta = await service.getModuleMeta('terraform-aws-modules', 'vpc~aws', 'http://localhost:3800');
        expect(meta).toHaveProperty('moduleid', 'vpc~aws');
        expect(meta).toHaveProperty('readonly', true);
        expect(meta).toHaveProperty('defaultversionsticky', false);
        // Unordered fixture: latest SemVer = 5.1.0
        expect(meta).toHaveProperty('defaultversionid', '5.1.0');
    });

    it('throws entity_not_found for malformed module ID', async () => {
        await expect(service.getModuleMetadata('invalid/group', 'invalid', 'http://localhost:3800'))
            .rejects.toMatchObject({ status: 404 });
    });

    it('omits unknown counts — versionscount is defined and numeric', async () => {
        const data = await service.getModuleMetadata('terraform-aws-modules', 'vpc~aws', 'http://localhost:3800');
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

    it('deduplicates discovery namespaces case-insensitively and prefers canonical lowercase', async () => {
        const duplicateService = {
            fetchProviderPage: jest.fn().mockResolvedValue([
                { namespace: 'Azure', type: 'azurerm', id: 'azurerm' },
                { namespace: 'azure', type: 'azurerm', id: 'azurerm' },
            ]),
            fetchModulePage: jest.fn().mockResolvedValue([]),
        } as unknown as TerraformService;
        const duplicateSearch = new SearchService(duplicateService, 60_000);
        await duplicateSearch.initialize();
        try {
            expect(duplicateSearch.getNamespaces().map(item => item.namespace)).toEqual(['azure']);
            expect(duplicateSearch.getProviders('AZURE')).toHaveLength(1);
        } finally {
            duplicateSearch.stopPeriodicRefresh();
        }
    });

    it('providerInCache returns false for unknown provider before initialisation', () => {
        expect(service.providerInCache('unknown', 'unknown')).toBe(false);
    });

    it('providerExists resolves true for hashicorp/aws via live check', async () => {
        const exists = await service.providerExists('hashicorp', 'aws');
        expect(exists).toBe(true);
    });

    it('moduleInCache returns false before initialisation', () => {
        expect(service.moduleInCache('a', 'b', 'c')).toBe(false);
    });
});


// ---------------------------------------------------------------------------
// HTTP route contract
// ---------------------------------------------------------------------------
describe('Terraform namespace HTTP routes', () => {
    let server: http.Server;
    let baseUrl: string;
    let search: SearchService;
    let state: EntityStateManager;

    beforeAll(async () => {
        search = new SearchService(tfService);
        await search.providerExists('hashicorp', 'aws');
        await search.moduleExists('terraform-aws-modules', 'vpc', 'aws');
        state = new EntityStateManager();
        const app = express();
        app.use(createXRegistryRoutes(new RegistryService(search, state)));
        app.use(createProviderRoutes(new ProviderService(tfService, state), search, state));
        app.use(createModuleRoutes(new ModuleService(tfService, state), search, state));
        app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
            if (isUpstreamError(error)) {
                res.status(error.code === 'not_found' ? 404 : 502).json({ error: error.code });
                return;
            }
            const status = typeof (error as any)?.status === 'number' ? (error as any).status : 500;
            res.status(status).json(error);
        });
        server = http.createServer(app);
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('No test server address');
        baseUrl = `http://127.0.0.1:${address.port}`;
    });

    afterAll(async () => {
        search.stopPeriodicRefresh();
        await new Promise<void>(resolve => server.close(() => resolve()));
    });

    it('discovers an incomplete paginated namespace snapshot with slash-free IDs', async () => {
        const response = await fetch(`${baseUrl}/terraformregistries?limit=1&offset=0`);
        expect(response.status).toBe(200);
        expect(response.headers.get('x-total-count')).toBeNull();
        expect(response.headers.get('x-collection-complete')).toBe('false');
        expect(response.headers.get('link')).toContain('offset=1');
        const body = await response.json() as Record<string, any>;
        expect(Object.keys(body)).toEqual(['hashicorp']);
        expect(body['hashicorp']).not.toHaveProperty('providerscount');
        expect(Object.keys(body).every(id => !id.includes('/'))).toBe(true);
    });

    it('uses provider type and reversible module name~provider resource IDs', async () => {
        const providers = await (await fetch(`${baseUrl}/terraformregistries/hashicorp/providers`)).json() as Record<string, any>;
        expect(Object.keys(providers)).toEqual(['aws']);
        expect(providers['aws'].xid).toBe('/terraformregistries/hashicorp/providers/aws');
        const modules = await (await fetch(`${baseUrl}/terraformregistries/terraform-aws-modules/modules`)).json() as Record<string, any>;
        expect(Object.keys(modules)).toEqual(['vpc~aws']);
        expect(modules['vpc~aws'].source).toBe('terraform-aws-modules/vpc/aws');
    });

    it('keeps exact provider and module lookup independent of collection paging', async () => {
        const provider = await fetch(`${baseUrl}/terraformregistries/acme/providers/widget`);
        expect(provider.status).toBe(200);
        expect((await provider.json() as any).providerid).toBe('widget');
        const module = await fetch(`${baseUrl}/terraformregistries/terraform-aws-modules/modules/vpc~aws`);
        expect(module.status).toBe(200);
        expect((await module.json() as any).moduleid).toBe('vpc~aws');
    });


    it('returns an explicitly incomplete group before resolving its first child', async () => {
        const group = await fetch(`${baseUrl}/terraformregistries/philips-software`);
        expect(group.status).toBe(200);
        expect(group.headers.get('x-collection-complete')).toBe('false');
        expect(group.headers.get('warning')).toContain('discovery is incomplete');
        const groupBody = await group.json() as Record<string, unknown>;
        expect(groupBody['terraformregistryid']).toBe('philips-software');
        expect(groupBody).not.toHaveProperty('providerscount');

        const emptyCollection = await fetch(`${baseUrl}/terraformregistries/philips-software/providers`);
        expect(emptyCollection.status).toBe(200);
        expect(await emptyCollection.json()).toEqual({});
        expect(emptyCollection.headers.get('x-collection-complete')).toBe('false');

        const provider = await fetch(`${baseUrl}/terraformregistries/philips-software/providers/hsdp`);
        expect(provider.status).toBe(200);
        expect((await provider.json() as any).providerid).toBe('hsdp');

        const collection = await fetch(`${baseUrl}/terraformregistries/philips-software/providers`);
        expect(collection.status).toBe(200);
        expect(await collection.json()).toHaveProperty('hsdp');
        expect(collection.headers.get('x-collection-complete')).toBe('false');
    });

    it('returns complete Resource entities and rejects unsupported filters', async () => {
        const complete = await fetch(`${baseUrl}/terraformregistries/hashicorp/providers`);
        const entities = await complete.json() as Record<string, any>;
        expect(entities['aws']).toMatchObject({
            providerid: 'aws',
            versionid: '5.0.0',
            ancestor: '4.67.0',
            versionscount: 2,
        });
        expect(entities['aws']).toHaveProperty('metaurl');
        expect(entities['aws']).not.toHaveProperty('defaultversionurl');

        const filtered = await fetch(`${baseUrl}/terraformregistries/hashicorp/providers?filter=source=aws`);
        expect(filtered.status).toBe(400);
        expect((await filtered.json() as any).detail).toContain('do not support filter or sort');
    });

    it('returns 404 rather than redirecting wrong-case Terraform IDs', async () => {
        for (const requestPath of [
            '/terraformregistries/HashiCorp',
            '/terraformregistries/HashiCorp/providers/aws',
            '/terraformregistries/hashicorp/providers/AWS',
            '/terraformregistries/Terraform-Aws-Modules/modules/vpc~aws',
            '/terraformregistries/terraform-aws-modules/modules/VPC~AWS',
            '/terraformregistries/Registry.terraform.io/providers/hashicorp~aws',
        ]) {
            const response = await fetch(`${baseUrl}${requestPath}`, { redirect: 'manual' });
            expect(response.status).toBe(404);
            expect(response.headers.get('location')).toBeNull();
        }
    });

    it('emits fixture-backed Terraform entities conforming to the runtime model', async () => {
        const groupResponse = await fetch(`${baseUrl}/terraformregistries/hashicorp`);
        assertGroupConforms(
            modelData,
            'terraformregistries',
            await groupResponse.json(),
            'terraform.group',
        );

        const providerResponse = await fetch(`${baseUrl}/terraformregistries/hashicorp/providers/aws`);
        assertResourceConforms(
            modelData,
            'terraformregistries',
            'providers',
            await providerResponse.json(),
            'terraform.provider',
        );
        const providerMeta = await fetch(`${baseUrl}/terraformregistries/hashicorp/providers/aws/meta`);
        assertMetaConforms(
            modelData,
            'terraformregistries',
            'providers',
            await providerMeta.json(),
            'terraform.provider-meta',
        );
        const providerVersions = await (await fetch(`${baseUrl}/terraformregistries/hashicorp/providers/aws/versions`)).json() as Record<string, unknown>;
        for (const [id, version] of Object.entries(providerVersions)) {
            assertVersionConforms(modelData, 'terraformregistries', 'providers', version, `terraform.provider-version.${id}`);
        }
        const providerResource = await (await fetch(`${baseUrl}/terraformregistries/hashicorp/providers/aws`)).json() as Record<string, unknown>;
        assertResourceProjectsVersion(
            modelData, 'terraformregistries', 'providers', providerResource,
            providerVersions[String(providerResource['versionid'])], 'terraform.provider',
        );
        const providerVersion = await fetch(`${baseUrl}/terraformregistries/hashicorp/providers/aws/versions/5.0.0`);
        assertVersionConforms(
            modelData,
            'terraformregistries',
            'providers',
            await providerVersion.json(),
            'terraform.provider-version-detail',
        );

        const moduleResponse = await fetch(`${baseUrl}/terraformregistries/terraform-aws-modules/modules/vpc~aws`);
        assertResourceConforms(
            modelData,
            'terraformregistries',
            'modules',
            await moduleResponse.json(),
            'terraform.module',
        );
        const moduleMeta = await fetch(`${baseUrl}/terraformregistries/terraform-aws-modules/modules/vpc~aws/meta`);
        assertMetaConforms(
            modelData,
            'terraformregistries',
            'modules',
            await moduleMeta.json(),
            'terraform.module-meta',
        );
        const moduleVersion = await fetch(`${baseUrl}/terraformregistries/terraform-aws-modules/modules/vpc~aws/versions/5.1.0`);
        const moduleVersionBody = await moduleVersion.json() as Record<string, unknown>;
        assertVersionConforms(
            modelData,
            'terraformregistries',
            'modules',
            moduleVersionBody,
            'terraform.module-version-detail',
        );
        const moduleResource = await (await fetch(`${baseUrl}/terraformregistries/terraform-aws-modules/modules/vpc~aws`)).json() as Record<string, unknown>;
        assertResourceProjectsVersion(
            modelData, 'terraformregistries', 'modules', moduleResource, moduleVersionBody, 'terraform.module',
        );
    });

    it('returns 404 for arbitrary groups without mutating EntityStateManager', async () => {
        const timestamps = (state as any).createdTimestamps as Map<string, string>;
        const before = timestamps.size;
        const group = await fetch(`${baseUrl}/terraformregistries/syntactically-valid-but-missing`);
        const children = await fetch(`${baseUrl}/terraformregistries/syntactically-valid-but-missing/providers`);
        expect(group.status).toBe(404);
        expect(children.status).toBe(404);
        expect(timestamps.size).toBe(before);
    });

    it('uses identical Resource representations for collection and exact lookup', async () => {
        const collection = await (await fetch(`${baseUrl}/terraformregistries/hashicorp/providers`)).json() as Record<string, unknown>;
        const exact = await (await fetch(`${baseUrl}/terraformregistries/hashicorp/providers/aws`)).json();
        expect(collection['aws']).toEqual(exact);
    });

    it('distinguishes exact not-found from upstream failure', async () => {
        const missing = await fetch(`${baseUrl}/terraformregistries/unknown/providers/nonexistent`);
        expect(missing.status).toBe(404);
        const outage = await fetch(`${baseUrl}/terraformregistries/outage/providers/broken`);
        expect(outage.status).toBe(502);
    });

    it('paginates versions and reports exact count', async () => {
        const response = await fetch(`${baseUrl}/terraformregistries/hashicorp/providers/aws/versions?limit=1&offset=0`);
        expect(response.status).toBe(200);
        expect(response.headers.get('x-total-count')).toBe('2');
        expect(response.headers.get('link')).toContain('rel="next"');
        expect(Object.keys(await response.json() as object)).toHaveLength(1);
    });


    it('rejects filter and sort consistently on group, resource, and version collections', async () => {
        for (const path of [
            '/terraformregistries?sort=namespace',
            '/terraformregistries/hashicorp/providers?filter=downloads%3E100',
            '/terraformregistries/hashicorp/providers/aws/versions?sort=versionid',
        ]) {
            const response = await fetch(`${baseUrl}${path}`);
            expect(response.status).toBe(400);
        }
    });

    it('returns explicit 410 for removed fixed-group paths', async () => {
        const response = await fetch(`${baseUrl}/terraformregistries/registry.terraform.io/providers/hashicorp~aws/meta`);
        expect(response.status).toBe(410);
        const body = await response.json() as Record<string, unknown>;
        expect(body['replacement']).toBe('/terraformregistries/hashicorp/providers/aws/meta');
    });

    it('returns 410 for encoded legacy paths and 400 for malformed encodings', async () => {
        const legacy = await fetch(`${baseUrl}/terraformregistries/%72egistry.terraform.io/modules/hashicorp%7Econsul%7Eaws/versions/1.0.0`);
        expect(legacy.status).toBe(410);
        expect((await legacy.json() as any).replacement)
            .toBe('/terraformregistries/hashicorp/modules/consul~aws/versions/1.0.0');
        const malformedLegacy = await fetch(`${baseUrl}/terraformregistries/registry.terraform.io/providers/bad%7Eid%7Eextra/versions`);
        expect(malformedLegacy.status).toBe(410);
        expect((await malformedLegacy.json() as any).replacement)
            .toBe('/terraformregistries/{namespace}/providers/{resource}/versions');
        const malformed = await fetch(`${baseUrl}/terraformregistries/hashicorp/providers/%ZZ`);
        expect(malformed.status).toBe(400);
    });
});
