import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { startFixtureServer, type FixtureServer } from '@xregistry/registry-core';
import type { Express } from 'express';
import type { PackagistPackage } from '../../src/types/packagist';
import modelData from '../../model.json';

const {
    assertGroupConforms,
    assertMetaConforms,
    assertResourceConforms,
    assertResourceProjectsVersion,
    assertVersionConforms,
} = require(path.join(__dirname, '../../../test/helpers/xregistry-model-conformance.cjs'));

const { assertCapabilitiesConform } = require(
    path.join(__dirname, "../../../test/helpers/xregistry-capability-conformance.cjs"),
);

interface JsonResponse { status: number; body: Record<string, any>; headers: Headers }

async function getJson(baseUrl: string, requestPath: string): Promise<JsonResponse> {
    const response = await fetch(`${baseUrl}${requestPath}`);
    return { status: response.status, body: await response.json() as Record<string, any>, headers: response.headers };
}

describe('Packagist native grouping HTTP server', () => {
    let fixture: FixtureServer;
    let server: http.Server;
    let baseUrl: string;
    let cacheDir: string;
    const previousEnv: Record<string, string | undefined> = {};

    beforeAll(async () => {
        const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/symfony-console.json'), 'utf8')) as { package: PackagistPackage };
        const budgetNames = Array.from({ length: 101 }, (_, index) => `budget/pkg-${String(index).padStart(3, '0')}`);
        const versions = Object.values(raw.package.versions);
        const stableVersions = versions.filter(version =>
            !version.version.startsWith('dev-') && !version.version.endsWith('-dev'),
        );
        const developmentVersions = versions.filter(version =>
            version.version.startsWith('dev-') || version.version.endsWith('-dev'),
        );
        const feedRoutes = (name: string) => [
            { path: `/p2/${name}.json`, responses: [{ body: { packages: { [name]: stableVersions } } }] },
            { path: `/p2/${name}~dev.json`, responses: [{ body: { packages: { [name]: developmentVersions } } }] },
        ];
        fixture = await startFixtureServer([
            { path: '/packages/list.json', responses: [{ body: { packageNames: ['laravel/framework', 'symfony/console', 'symfony/routing', 'packagist.org/example', ...budgetNames] } }] },
            ...feedRoutes('symfony/console'),
            ...feedRoutes('symfony/routing'),
            ...feedRoutes('packagist.org/example'),
            ...budgetNames.flatMap(feedRoutes),
        ]);
        cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'packagist-server-test-'));
        for (const name of ['PACKAGIST_URL', 'CACHE_DIR', 'CACHE_TTL_MS']) previousEnv[name] = process.env[name];
        process.env['PACKAGIST_URL'] = fixture.url;
        process.env['CACHE_DIR'] = cacheDir;
        process.env['CACHE_TTL_MS'] = '60000';
        const { app } = await import('../../src/server') as { app: Express };
        server = http.createServer(app);
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('No test server address');
        baseUrl = `http://127.0.0.1:${address.port}`;
    });

    afterAll(async () => {
        await new Promise<void>(resolve => server.close(() => resolve()));
        await fixture.close();
        fs.rmSync(cacheDir, { recursive: true, force: true });
        for (const [name, value] of Object.entries(previousEnv)) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    });

    it("serves the complete schema-valid rc2 capability contract", async () => {
        const response = await getJson(baseUrl, "/capabilities");
        expect(response.status).toBe(200);
        assertCapabilitiesConform(response.body, {
            flags: ["filter", "sort"],
            versionmodes: ["manual", "createdat"],
        });
    });

    it('serves a built-in Resource version model without nested Versions', async () => {
        const response = await getJson(baseUrl, '/model');
        const packages = response.body['groups']['composerregistries']['resources']['packages'];
        expect(packages['maxversions']).toBe(0);
        expect(packages['versionmode']).toBe('createdat');
        expect(packages).not.toHaveProperty('versions');
        expect(packages).not.toHaveProperty('resources');
        expect(packages['attributes']).toHaveProperty('versionid');
        expect(packages['resourceattributes']).toHaveProperty('versionscount');
        expect(packages['metaattributes']).toHaveProperty('defaultversionurl');
        const source = await getJson(baseUrl, '/modelsource');
        expect(source.body).toEqual(modelData);
        expect(Object.keys(source.body).sort()).toEqual(Object.keys(modelData).sort());
        expect(source.body).not.toHaveProperty("default");
        expect(response.body).not.toHaveProperty("default");
        expect(source.body['groups']['composerregistries']['resources']['packages']).not.toHaveProperty('resourceattributes');
    });

    it('performs exact lookup without first reading discovery', async () => {
        const beforeList = fixture.requests.filter(request => request.path === '/packages/list.json').length;
        const response = await getJson(baseUrl, '/composerregistries/symfony/packages/console');
        expect(response.status).toBe(200);
        expect(response.body['packageid']).toBe('console');
        expect(response.body['name']).toBe('symfony/console');
        expect(response.body['packagepath']).toBe('symfony/console');
        expect(response.body['xid']).toBe('/composerregistries/symfony/packages/console');
        expect(fixture.requests.filter(request => request.path === '/packages/list.json')).toHaveLength(beforeList);
    });

    it('discovers vendor groups with counts, filtering and pagination headers', async () => {
        const response = await getJson(baseUrl, '/composerregistries?filter=name=symfony&limit=1&offset=0');
        expect(response.status).toBe(200);
        expect(Object.keys(response.body)).toEqual(['symfony']);
        expect((response.body['symfony'] as Record<string, unknown>)['packagescount']).toBe(2);
        expect(response.headers.get('x-total-count')).toBe('1');
        expect((response.body['symfony'] as Record<string, unknown>)['composerregistryid']).toBe('symfony');
    });

    it('lists only package basenames within a vendor group', async () => {
        const response = await getJson(baseUrl, '/composerregistries/symfony/packages?limit=1&offset=0');
        expect(response.status).toBe(200);
        expect(Object.keys(response.body)).toEqual(['console']);
        expect(response.headers.get('x-total-count')).toBe('2');
        expect(response.headers.get('link')).toContain('offset=1');
        const entity = response.body['console'] as Record<string, unknown>;
        expect(entity['name']).toBe('symfony/console');
        expect(entity).toHaveProperty('versionid');
        expect(entity).toHaveProperty('ancestor');
        expect(entity).toHaveProperty('metaurl');
        expect(entity).toHaveProperty('versionscount');
    });

    it('keeps version XIDs and self links on the native path', async () => {
        const response = await getJson(baseUrl, '/composerregistries/symfony/packages/console/versions?limit=1');
        expect(response.status).toBe(200);
        const version = Object.values(response.body)[0] as Record<string, unknown>;
        expect(version['xid']).toMatch(/^\/composerregistries\/symfony\/packages\/console\/versions\//);
        expect(new URL(String(version['self'])).pathname).toMatch(/^\/composerregistries\/symfony\/packages\/console\/versions\//);
    });


    it('paginates the merged stable and development snapshot in canonical order', async () => {
        const response = await getJson(baseUrl, '/composerregistries/symfony/packages/console/versions?limit=100');
        expect(response.status).toBe(200);
        const versions = Object.values(response.body) as Record<string, unknown>[];
        expect(versions.some(version => version['immutable'] === false)).toBe(true);
        expect(versions.filter(version => version['isdefault'] === true)).toHaveLength(1);
        const ids = versions.map(version => String(version['versionid']));
        expect(ids).toEqual([...ids].sort((a, b) =>
            a.localeCompare(b, undefined, { sensitivity: 'base' }) || a.localeCompare(b),
        ));
    });

    it('uses the exact Resource representation in collections', async () => {
        const collection = await getJson(baseUrl, '/composerregistries/symfony/packages?limit=2');
        const exact = await getJson(baseUrl, '/composerregistries/symfony/packages/console');
        expect(collection.body['console']).toEqual(exact.body);
    });

    it('omits next on the terminal stable version page', async () => {
        const all = await getJson(baseUrl, '/composerregistries/symfony/packages/console/versions?limit=100');
        const total = Object.keys(all.body).length;
        const terminal = await getJson(baseUrl, `/composerregistries/symfony/packages/console/versions?limit=1&offset=${Math.max(0, total - 1)}`);
        expect(Object.keys(terminal.body)).toHaveLength(total === 0 ? 0 : 1);
        expect(terminal.headers.get('link') ?? '').not.toContain('rel="next"');
    });

    it('filters complete package entities by epoch', async () => {
        const response = await getJson(baseUrl, '/composerregistries/symfony/packages?filter=epoch=1');
        expect(response.status).toBe(200);
        expect(Object.keys(response.body)).toEqual(['console', 'routing']);
        expect(response.headers.get('x-total-count')).toBe('2');
        expect(Object.values(response.body).every(entity => (entity as Record<string, unknown>)['versionid'])).toBe(true);
    });

    it('returns complete rc2 package meta fields', async () => {
        const response = await getJson(baseUrl, '/composerregistries/symfony/packages/console/meta');
        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({
            packageid: 'console',
            defaultversionsticky: false,
            readonly: true,
        });
        expect(response.body['xid']).toBe('/composerregistries/symfony/packages/console/meta');
        expect(response.body).not.toHaveProperty('ancestor');
        expect(response.body).toHaveProperty('defaultversionurl');
    });

    it('returns 404 for wrong-case group and Resource IDs', async () => {
        for (const path of [
            '/composerregistries/Symfony',
            '/composerregistries/Symfony/packages/console',
            '/composerregistries/symfony/packages/Console',
            '/composerregistries/Packagist.org/packages/symfony~console',
        ]) {
            const response = await fetch(`${baseUrl}${path}`, { redirect: 'manual' });
            expect(response.status).toBe(404);
            expect(response.headers.get('location')).toBeNull();
        }
    });

    it('emits group, Resource, Meta, and Version entities conforming to its runtime model', async () => {
        const group = await getJson(baseUrl, '/composerregistries/symfony');
        assertGroupConforms(modelData, 'composerregistries', group.body, 'packagist.group');

        const resource = await getJson(baseUrl, '/composerregistries/symfony/packages/console');
        assertResourceConforms(modelData, 'composerregistries', 'packages', resource.body, 'packagist.resource');

        const meta = await getJson(baseUrl, '/composerregistries/symfony/packages/console/meta');
        assertMetaConforms(modelData, 'composerregistries', 'packages', meta.body, 'packagist.meta');

        const versions = await getJson(baseUrl, '/composerregistries/symfony/packages/console/versions?limit=100');
        for (const [id, version] of Object.entries(versions.body)) {
            assertVersionConforms(modelData, 'composerregistries', 'packages', version, `packagist.version.${id}`);
        }
        const selected = versions.body[String(resource.body['versionid'])];
        assertResourceProjectsVersion(modelData, 'composerregistries', 'packages', resource.body, selected, 'packagist.resource');
        expect(resource.body).not.toHaveProperty('defaultversionurl');
    });

    it('does not reserve a real packagist.org vendor group', async () => {
        const response = await getJson(baseUrl, '/composerregistries/packagist.org/packages/example');
        expect(response.status).toBe(200);
        expect(response.body['name']).toBe('packagist.org/example');
    });

    it('returns 404 for an unknown exact package route', async () => {
        const response = await getJson(baseUrl, '/composerregistries/unknown/packages/missing');
        expect(response.status).toBe(404);
    });

    it('returns explicit 410 with preserved suffixes for removed fixed-group identities', async () => {
        const response = await getJson(baseUrl, '/composerregistries/packagist.org/packages/symfony%7Econsole/versions/7.1.0.0');
        expect(response.status).toBe(410);
        expect(response.body['replacement']).toBe('/composerregistries/symfony/packages/console/versions/7.1.0.0');
    });

    it('uses the actual package type and suffix for malformed legacy identities', async () => {
        const response = await getJson(baseUrl, '/composerregistries/packagist.org/packages/bad%7Eid%7Eextra/meta');
        expect(response.status).toBe(410);
        expect(response.body['replacement']).toBe('/composerregistries/{vendor}/packages/{package}/meta');
    });

    it('rejects metadata-wide filtering without hydrating any package', async () => {
        const before = fixture.requests.filter(request => request.path.startsWith('/p2/budget/')).length;
        const response = await getJson(baseUrl, '/composerregistries/budget/packages?filter=description=tools*');
        const after = fixture.requests.filter(request => request.path.startsWith('/p2/budget/')).length;
        expect(response.status).toBe(400);
        expect(response.body['detail']).toContain('unbounded upstream hydration');
        expect(after).toBe(before);
    });

    it('caps collection hydration at 100 resources even when a larger limit is requested', async () => {
        const before = fixture.requests.filter(request => request.path.startsWith('/p2/budget/')).length;
        const response = await getJson(baseUrl, '/composerregistries/budget/packages?limit=1000');
        const after = fixture.requests.filter(request => request.path.startsWith('/p2/budget/')).length;
        expect(response.status).toBe(200);
        expect(Object.keys(response.body)).toHaveLength(100);
        // Stable + development feed for each selected Resource.
        expect(after - before).toBe(200);
        expect(response.headers.get('link')).toContain('offset=100');
    });
});
