/**
 * Unit tests for PackagistService.
 *
 * The service uses the shared `@xregistry/registry-core` `HttpUpstreamClient`.
 * These tests inject a minimal mock implementing `getJson`, which resolves to
 * an `HttpResponse` ({ status, value }) or rejects with an `UpstreamError`
 * (mirroring how the real client surfaces 404 / 429 / timeout upstream).
 */

import { UpstreamError } from '@xregistry/registry-core';
import * as path from 'path';
import * as fs from 'fs';
import { PackagistService, type UpstreamHttp } from '../../../src/services/packagist-service';
import { isDevVersion } from '../../../src/utils/package-utils';
import type { PackagistPackage, PackagistVersion } from '../../../src/types/packagist';

// Load deterministic fixtures
function loadFixture(filename: string): unknown {
    const fp = path.join(__dirname, '../../fixtures', filename);
    return JSON.parse(fs.readFileSync(fp, 'utf-8'));
}

const symfonyConsoleFixture = loadFixture('symfony-console.json') as { package: PackagistPackage };
const laravelFixture = loadFixture('laravel-framework.json') as { package: PackagistPackage };

const BASE_URL = 'http://localhost:4100';

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface HttpMock extends UpstreamHttp {
    getJson: jest.Mock;
}

function makeHttpMock(): HttpMock {
    return { getJson: jest.fn() } as HttpMock;
}

/** Wrap a JSON body as a successful HttpResponse. */
function ok<T>(value: T): { status: number; value: T } {
    return { status: 200, value };
}

/** Upstream 404 as surfaced by HttpUpstreamClient. */
function notFound(): UpstreamError {
    return new UpstreamError({ code: 'not_found', message: 'Upstream resource was not found', status: 404 });
}

/** Configure the mock to miss on v2 (empty packages) and hit on the v1 fallback. */
function mockV1Only(http: HttpMock, fixture: { package: unknown }): void {
    http.getJson
        .mockResolvedValueOnce(ok({ packages: {} }))   // v2 miss
        .mockResolvedValueOnce(ok(fixture));           // v1 hit
}

describe('PackagistService', () => {
    let http: HttpMock;
    let service: PackagistService;

    beforeEach(() => {
        http = makeHttpMock();
        service = new PackagistService({ packagistBaseUrl: 'https://packagist.org', http });
    });

    function getHttpMock(): HttpMock {
        return http;
    }

    describe('fetchPackage', () => {
        it('returns null for 404 on v2 and v1', async () => {
            const http = getHttpMock();
            http.getJson.mockRejectedValue(notFound());

            const result = await service.fetchPackage('no/such-package');
            expect(result).toBeNull();
        });

        it('falls back to v1 when v2 returns empty packages', async () => {
            const http = getHttpMock();
            http.getJson
                .mockResolvedValueOnce(ok({ packages: {} }))      // v2 miss
                .mockResolvedValueOnce(ok(symfonyConsoleFixture)); // v1 hit

            const result = await service.fetchPackage('symfony/console');
            expect(result).not.toBeNull();
            expect(result!.name).toBe('symfony/console');
        });

        it('uses v2 data when packages key present', async () => {
            const http = getHttpMock();
            const v2Versions = Object.values(symfonyConsoleFixture.package.versions);
            http.getJson.mockResolvedValueOnce(ok({ packages: { 'symfony/console': v2Versions } }));

            const result = await service.fetchPackage('symfony/console');
            expect(result).not.toBeNull();
            expect(result!.name).toBe('symfony/console');
        });
    });

    describe('getVersions – dev-* identity rule', () => {
        it('marks stable versions as immutable=true', async () => {
            const http = getHttpMock();
            mockV1Only(http, symfonyConsoleFixture);

            const versions = await service.getVersions('symfony/console', BASE_URL);
            const stable = versions.find(v => v.version === 'v7.1.0');

            expect(stable).toBeDefined();
            expect(stable!.immutable).toBe(true);
        });

        it('marks dev-* versions as immutable=false', async () => {
            const http = getHttpMock();
            mockV1Only(http, symfonyConsoleFixture);

            const versions = await service.getVersions('symfony/console', BASE_URL);
            const dev = versions.find(v => isDevVersion(v.version));

            expect(dev).toBeDefined();
            expect(dev!.immutable).toBe(false);
        });

        it('includes sourceReference in dev-* version entities', async () => {
            const http = getHttpMock();
            mockV1Only(http, symfonyConsoleFixture);

            const versions = await service.getVersions('symfony/console', BASE_URL);
            const dev = versions.find(v => isDevVersion(v.version));

            expect(dev!.sourceReference).toBeDefined();
            expect(typeof dev!.sourceReference).toBe('string');
        });

        it('produces collision-safe versionid for dev-* that includes source ref', async () => {
            const http = getHttpMock();
            mockV1Only(http, symfonyConsoleFixture);

            const versions = await service.getVersions('symfony/console', BASE_URL);
            const dev = versions.find(v => isDevVersion(v.version));

            // versionId must contain the first 12 chars of the commit SHA
            expect(dev!.versionid).toContain('deadbeef1234');
        });

        it('produces stable, opaque versionid for stable releases', async () => {
            const http = getHttpMock();
            mockV1Only(http, symfonyConsoleFixture);

            const versions = await service.getVersions('symfony/console', BASE_URL);
            const stable = versions.find(v => v.version === 'v7.1.0');

            // Stable ID should be the normalized version
            expect(stable!.versionid).toBe('7.1.0.0');
        });

        it('xid and self follow the expected URL structure', async () => {
            const http = getHttpMock();
            mockV1Only(http, symfonyConsoleFixture);

            const versions = await service.getVersions('symfony/console', BASE_URL);
            const stable = versions.find(v => v.version === 'v7.1.0');

            expect(stable!.xid).toMatch(/^\/composerregistries\/packagist\.org\/packages\/symfony~console\/versions\//);
            expect(stable!.self).toMatch(/^http:\/\/localhost:4100\/composerregistries\/packagist\.org\/packages\/symfony~console\/versions\//);
        });
    });

    describe('getVersion', () => {
        it('returns null when version not found', async () => {
            const http = getHttpMock();
            mockV1Only(http, symfonyConsoleFixture);

            const result = await service.getVersion('symfony/console', 'no-such-version', BASE_URL);
            expect(result).toBeNull();
        });

        it('returns the correct version entity for a stable versionId', async () => {
            const http = getHttpMock();
            mockV1Only(http, symfonyConsoleFixture);

            const result = await service.getVersion('symfony/console', '7.1.0.0', BASE_URL);
            expect(result).not.toBeNull();
            expect(result!.version).toBe('v7.1.0');
            expect(result!.immutable).toBe(true);
        });
    });

    describe('getPackageResource', () => {
        it('returns null for non-existent package', async () => {
            const http = getHttpMock();
            http.getJson.mockRejectedValue(notFound());

            const result = await service.getPackageResource('no/such', BASE_URL);
            expect(result).toBeNull();
        });

        it('returns a resource with correct xid/self for laravel/framework', async () => {
            const http = getHttpMock();
            mockV1Only(http, laravelFixture);

            const result = await service.getPackageResource('laravel/framework', BASE_URL);
            expect(result).not.toBeNull();
            expect(result!.xid).toBe('/composerregistries/packagist.org/packages/laravel~framework');
            expect(result!.self).toBe(`${BASE_URL}/composerregistries/packagist.org/packages/laravel~framework`);
            expect(result!.packageid).toBe('laravel~framework');
        });

        it('exposes versionsurl and versionscount', async () => {
            const http = getHttpMock();
            mockV1Only(http, laravelFixture);

            const result = await service.getPackageResource('laravel/framework', BASE_URL);
            expect(result!.versionsurl).toBeDefined();
            expect(result!.versionscount).toBeGreaterThan(0);
        });

        it('identifies the default package version', async () => {
            const http = getHttpMock();
            mockV1Only(http, laravelFixture);

            const result = await service.getPackageResource('laravel/framework', BASE_URL);

            expect(result).toEqual(expect.objectContaining({
                versionid: expect.any(String),
                isdefault: true,
            }));
        });
    });

    describe('package collections', () => {
        it('uses the package list endpoint for an unfiltered page', async () => {
            const http = getHttpMock();
            http.getJson.mockResolvedValueOnce(ok({
                packageNames: ['acme/one', 'acme/two', 'acme/three'],
            }));

            const result = await service.listPackages(1, 2);

            expect(http.getJson).toHaveBeenCalledWith('https://packagist.org/packages/list.json');
            expect(result.total).toBe(3);
            expect(result.packages.map(pkg => pkg.name)).toEqual(['acme/one', 'acme/two']);
        });

        it('sends a prefix query to Packagist search', async () => {
            const http = getHttpMock();
            http.getJson.mockResolvedValueOnce(ok({
                results: [{ name: 'symfony/console', description: 'Console tools' }],
                total: 1,
            }));

            const result = await service.searchPackages('symfony/', 1, 15);

            expect(http.getJson).toHaveBeenCalledWith(
                'https://packagist.org/search.json?q=symfony%2F&page=1&per_page=15',
            );
            expect(result.packages[0]?.name).toBe('symfony/console');
        });

        it('paginates prefix matches from the complete package-name catalog', async () => {
            const http = getHttpMock();
            const packageNames = Array.from({ length: 350 }, (_, index) => `vendor/package-${index}`);
            packageNames.splice(25, 0, 'symfony/console');
            packageNames.splice(325, 0, 'symfony/http-foundation', 'symfony/routing');
            http.getJson.mockResolvedValueOnce(ok({ packageNames }));

            const result = await service.searchPackagesByPrefix('symfony/', 2, 2);

            expect(http.getJson).toHaveBeenCalledTimes(1);
            expect(http.getJson).toHaveBeenCalledWith('https://packagist.org/packages/list.json');
            expect(result).toEqual({
                packages: [expect.objectContaining({ name: 'symfony/routing' })],
                total: 3,
            });
        });
    });

    describe('buildGroupEntity', () => {
        const STABLE_TIMESTAMPS = {
            createdat: '2026-01-01T00:00:00.000Z',
            modifiedat: '2026-01-01T00:00:00.000Z',
        };

        it('returns a valid group entity for packagist.org', () => {
            const group = service.buildGroupEntity(BASE_URL, STABLE_TIMESTAMPS);
            expect(group.xid).toBe('/composerregistries/packagist.org');
            expect(group.self).toBe(`${BASE_URL}/composerregistries/packagist.org`);
            expect(group['composerregistriesid']).toBe('packagist.org');
        });

        it('does not emit a fabricated packagescount', () => {
            const group = service.buildGroupEntity(BASE_URL, STABLE_TIMESTAMPS);
            expect(group['packagescount']).toBeUndefined();
        });

        it('produces identical JSON across two calls with the same timestamps (stable ETag)', () => {
            const group1 = service.buildGroupEntity(BASE_URL, STABLE_TIMESTAMPS);
            const group2 = service.buildGroupEntity(BASE_URL, STABLE_TIMESTAMPS);
            expect(JSON.stringify(group1)).toBe(JSON.stringify(group2));
        });

        it('produces different JSON when timestamps differ (ETag changes on modification)', () => {
            const group1 = service.buildGroupEntity(BASE_URL, STABLE_TIMESTAMPS);
            const group2 = service.buildGroupEntity(BASE_URL, {
                createdat: STABLE_TIMESTAMPS.createdat,
                modifiedat: '2026-07-01T00:00:00.000Z',
            });
            expect(JSON.stringify(group1)).not.toBe(JSON.stringify(group2));
        });

        it('collection entity wrapping group also has stable JSON for given timestamps (regression: 304 on GET /composerregistries)', () => {
            const collection1 = { ['packagist.org']: service.buildGroupEntity(BASE_URL, STABLE_TIMESTAMPS) };
            const collection2 = { ['packagist.org']: service.buildGroupEntity(BASE_URL, STABLE_TIMESTAMPS) };
            expect(JSON.stringify(collection1)).toBe(JSON.stringify(collection2));
        });
    });

    describe('error handling', () => {
        it('propagates upstream timeout as an UpstreamError (code=timeout)', async () => {
            const http = getHttpMock();
            http.getJson.mockRejectedValue(new UpstreamError({ code: 'timeout', message: 'Upstream operation timed out' }));

            await expect(service.fetchPackage('symfony/console')).rejects.toMatchObject({
                code: 'timeout',
            });
        });

        it('propagates upstream rate limiting as an UpstreamError (code=rate_limited)', async () => {
            const http = getHttpMock();
            http.getJson.mockRejectedValue(new UpstreamError({ code: 'rate_limited', message: 'Upstream rate limit exceeded', status: 429 }));

            await expect(service.fetchPackage('symfony/console')).rejects.toMatchObject({
                code: 'rate_limited',
            });
        });
    });

    describe('Packagist p2 minified format (composer/2.0)', () => {
        const minifiedFixture = loadFixture('symfony-console-p2-minified.json') as {
            minified: string;
            packages: Record<string, PackagistVersion[]>;
        };

        it('inflates inherited fields from prototype into subsequent version entries', async () => {
            const http = getHttpMock();
            http.getJson.mockResolvedValueOnce(ok(minifiedFixture));

            const result = await service.fetchPackage('symfony/console');
            expect(result).not.toBeNull();

            // v7.0.0 must have inherited name/description/type from the v7.1.0 prototype
            const v70 = Object.values(result!.versions).find(v => v.version === 'v7.0.0');
            expect(v70).toBeDefined();
            expect(v70!.name).toBe('symfony/console');
            expect(v70!.type).toBe('library');

            // dev-main must also have inherited fields
            const devMain = Object.values(result!.versions).find(v => v.version === 'dev-main');
            expect(devMain).toBeDefined();
            expect(devMain!.name).toBe('symfony/console');
            expect(devMain!.license).toEqual(['MIT']);
        });

        it('generates collision-safe IDs for inflated dev-* entries', async () => {
            const http = getHttpMock();
            http.getJson.mockResolvedValueOnce(ok(minifiedFixture));

            const versions = await service.getVersions('symfony/console', BASE_URL);
            const devVersion = versions.find(v => v.version === 'dev-main');
            expect(devVersion).toBeDefined();
            expect(devVersion!.immutable).toBe(false);
            expect(devVersion!.versionid).toContain('deadbeef1234');
            expect(devVersion!.sourceReference).toBe('deadbeef1234567890abcdef1234567890abcdef');
        });
    });
});
