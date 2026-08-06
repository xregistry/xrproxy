/**
 * Integration-style tests for the Go Module proxy server.
 *
 * Fully deterministic: the upstream GOPROXY and checksum DB are fixture HTTP
 * servers. Their URLs are injected into GoModuleService via the constructor.
 * No real network calls are made.
 */

import * as http from 'http';
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import express, { ErrorRequestHandler } from 'express';
import { startFixtureServer, type FixtureRoute, type FixtureServer } from '@xregistry/registry-core';

import { CheckpointService } from '../src/services/checkpoint-service';
import { GoModuleService } from '../src/services/go-module-service';
import { ModuleService } from '../src/services/module-service';
import { RegistryService } from '../src/services/registry-service';
import { createModuleRoutes } from '../src/routes/modules';
import { createXRegistryRoutes } from '../src/routes/xregistry';
import { corsMiddleware } from '../src/middleware/cors';
import { xregistryErrorHandler } from '../src/middleware/xregistry-error-handler';
import { escapePath, escapeVersion } from '../src/utils/path-escaping';
import { EntityStateManager } from '../../shared/entity-state-manager';

interface FixtureVersion {
    version: string;
    timestamp: string;
    infoResponse: { Version: string; Time: string };
    gomod?: string | null;
    checksumLookup?: string | null;
}

interface FixtureModule {
    path: string;
    versions: FixtureVersion[];
}

function loadFixtureModules(): FixtureModule[] {
    const file = path.join(__dirname, '..', 'fixtures', 'modules.json');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as { modules: FixtureModule[] };
    return parsed.modules;
}

function buildProxyRoutes(modules: FixtureModule[]): FixtureRoute[] {
    const routes: FixtureRoute[] = [];

    for (const module of modules) {
        const ep = escapePath(module.path);
        const sortedVersions = [...module.versions].sort((a, b) => a.version.localeCompare(b.version));
        const latest = [...module.versions]
            .filter((entry) => entry.infoResponse.Time)
            .sort((a, b) => a.infoResponse.Time.localeCompare(b.infoResponse.Time))
            .at(-1) ?? module.versions[0];

        for (const version of module.versions) {
            const ev = escapeVersion(version.version);
            routes.push({ method: 'GET', path: `/${ep}/@v/${ev}.info`, responses: [{ body: version.infoResponse }] });
            if (version.gomod !== null && version.gomod !== undefined) {
                routes.push({
                    method: 'GET',
                    path: `/${ep}/@v/${ev}.mod`,
                    responses: [{ headers: { 'content-type': 'text/plain' }, body: version.gomod }],
                });
            }
        }

        routes.push({ method: 'GET', path: `/${ep}/@latest`, responses: [{ body: latest.infoResponse }] });
        routes.push({
            method: 'GET',
            path: `/${ep}/@v/list`,
            responses: [{ headers: { 'content-type': 'text/plain' }, body: sortedVersions.map((version) => version.version).join('\n') + '\n' }],
        });
    }

    return routes;
}

function buildSumDbRoutes(modules: FixtureModule[]): FixtureRoute[] {
    const routes: FixtureRoute[] = [];
    for (const module of modules) {
        for (const version of module.versions) {
            if (!version.checksumLookup) continue;
            routes.push({
                method: 'GET',
                path: `/lookup/${escapePath(module.path)}@${escapeVersion(version.version)}`,
                responses: [{ headers: { 'content-type': 'text/plain' }, body: version.checksumLookup }],
            });
        }
    }
    return routes;
}

function getFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.listen(0, () => {
            const addr = srv.address() as net.AddressInfo;
            srv.close(() => resolve(addr.port));
        });
        srv.on('error', reject);
    });
}

async function getJson(url: string): Promise<{ status: number; data: any; headers: Headers }> {
    const res = await fetch(url);
    const text = await res.text();
    let data: any = undefined;
    try { data = text ? JSON.parse(text) : undefined; } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
}

describe('Go Module Proxy Server', () => {
    let server: http.Server;
    let baseUrl: string;
    let tmpDir: string;
    let proxyFixture: FixtureServer;
    let sumDbFixture: FixtureServer;

    beforeAll(async () => {
        const fixtures = loadFixtureModules();

        proxyFixture = await startFixtureServer(buildProxyRoutes(fixtures));
        sumDbFixture = await startFixtureServer(buildSumDbRoutes(fixtures));

        tmpDir = path.join(__dirname, '.test-work', `server-${Date.now()}-${Math.random().toString(16).slice(2)}`);
        fs.mkdirSync(tmpDir, { recursive: true });
        const cp = new CheckpointService(tmpDir);
        for (const module of fixtures) {
            cp.mergeEntries(module.versions.map((version) => ({
                path: module.path,
                version: version.version,
                timestamp: version.timestamp,
            })));
        }
        cp.updateCheckpoint('2024-05-01T00:00:00Z');

        const goSvc = new GoModuleService(cp, {
            proxyBaseUrl: proxyFixture.url,
            indexBaseUrl: proxyFixture.url,
            sumDbBaseUrl: sumDbFixture.url,
        });
        const entityState = new EntityStateManager();
        const moduleSvc = new ModuleService(goSvc, cp, entityState);
        const registrySvc = new RegistryService(cp, entityState);

        const app = express();
        app.use(corsMiddleware);
        app.use(express.json());
        app.use('/', createXRegistryRoutes(registrySvc));
        app.use('/', createModuleRoutes(moduleSvc, cp));
        app.use(xregistryErrorHandler as ErrorRequestHandler);

        const port = await getFreePort();
        server = http.createServer(app);
        await new Promise<void>((resolve) => server.listen(port, resolve));
        baseUrl = `http://localhost:${port}`;
    });

    afterAll(async () => {
        if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
        if (proxyFixture) await proxyFixture.close();
        if (sumDbFixture) await sumDbFixture.close();
        if (tmpDir) fs.rmSync(path.join(__dirname, '.test-work'), { recursive: true, force: true });
    });

    it('GET / returns xRegistry root', async () => {
        const { data, status } = await getJson(`${baseUrl}/`);
        expect(status).toBe(200);
        expect(data.specversion).toBe('1.0-rc2');
        expect(data.registryid).toBe('gomod-proxy');
        expect(data.goregistriesurl).toBeDefined();
        expect(data.goregistriescount).toBe(3);
    });

    it('GET /model returns the authoritative model', async () => {
        const { data, status } = await getJson(`${baseUrl}/model`);
        expect(status).toBe(200);
        expect(data.groups?.goregistries).toBeDefined();
        expect(data.groups.goregistries.resources?.modules?.metaattributes?.latest_version).toBeDefined();
        expect(data.groups.goregistries.resources?.modules?.attributes?.version?.required).toBe(true);
    });

    it('GET /capabilities returns capabilities', async () => {
        const { data, status } = await getJson(`${baseUrl}/capabilities`);
        expect(status).toBe(200);
        expect(Array.isArray(data.specversions)).toBe(true);
    });

    it('GET /goregistries returns group collection', async () => {
        const { data, status, headers } = await getJson(`${baseUrl}/goregistries`);
        expect(status).toBe(200);
        expect(Object.keys(data)).toEqual(['example.com', 'github.com', 'golang.org']);
        expect(headers.get('x-total-count')).toBe('3');
    });

    it('GET /goregistries supports filtered pagination', async () => {
        const filter = 'goregistryid=github.*';
        const { data, headers } = await getJson(
            `${baseUrl}/goregistries?filter=${encodeURIComponent(filter)}&limit=1`
        );
        expect(Object.keys(data)).toEqual(['github.com']);
        expect(headers.get('x-total-count')).toBe('1');
        expect(headers.get('link')).toBeNull();
    });

    it('GET /goregistries/github.com returns namespace detail', async () => {
        const { data, status } = await getJson(`${baseUrl}/goregistries/github.com`);
        expect(status).toBe(200);
        expect(data.goregistryid).toBe('github.com');
        expect(data.modulescount).toBe(5);
    });

    it('GET /goregistries/github.com/modules returns modules in that namespace with hashed case collisions', async () => {
        const { data, status, headers } = await getJson(`${baseUrl}/goregistries/github.com/modules`);
        expect(status).toBe(200);
        expect(data['pkg:errors']).toBeDefined();
        expect(Object.keys(data)).toEqual(expect.arrayContaining([
            'Case:Module',
            'gorilla:mux',
            'pkg:errors',
        ]));
        const hashedKeys = Object.keys(data).filter((key) => key.startsWith('xh~'));
        expect(hashedKeys).toHaveLength(1);
        expect(data[hashedKeys[0]].modulepath).toBe('github.com/case/module');
        expect(data.self).toBeUndefined();
        expect(data.modulescount).toBeUndefined();
        expect(data.modulesurl).toBeUndefined();
        expect(headers.get('x-total-count')).toBe('5');
    });

    it('GET /goregistries/github.com/modules supports pagination', async () => {
        const { data, headers } = await getJson(`${baseUrl}/goregistries/github.com/modules?limit=1&offset=0`);
        expect(Object.keys(data)).toHaveLength(1);
        expect(headers.get('x-total-count')).toBe('5');
        expect(headers.get('link')).toContain('offset=1&limit=1');
    });

    it('GET /goregistries/github.com/modules preserves filters across pages', async () => {
        const filter = 'name=github.com*';
        const { headers } = await getJson(
            `${baseUrl}/goregistries/github.com/modules?filter=${encodeURIComponent(filter)}&limit=1&offset=0`
        );
        expect(headers.get('x-total-count')).toBe('5');

        const link = headers.get('link');
        expect(link).not.toBeNull();
        const nextUrl = link!.match(/<([^>]+)>; rel="next"/)?.[1];
        expect(nextUrl).toBeDefined();
        expect(new URL(nextUrl!).searchParams.get('filter')).toBe(filter);

        const nextPage = await getJson(nextUrl!);
        expect(nextPage.headers.get('x-total-count')).toBe('5');
        expect(nextPage.headers.get('link')).toContain('rel="first"');
        expect(nextPage.headers.get('link')).toContain('rel="prev"');
    });

    it('GET module by encoded path returns module record with meta and checksum-db hashes', async () => {
        const { data, status } = await getJson(
            `${baseUrl}/goregistries/github.com/modules/pkg:errors`
        );
        expect(status).toBe(200);
        expect(data.moduleid).toBe('pkg:errors');
        expect(data.modulepath).toBe('github.com/pkg/errors');
        expect(data.versionid).toBe('v0.9.1');
        expect(data.version).toBe('v0.9.1');
        expect(data.isdefault).toBe(true);
        expect(data.meta.latest_version).toBe('v0.9.1');
        expect(data.meta.repository).toBe('https://github.com/pkg/errors');
        expect(data.gomod_hash).toBe('h1:bwawxfHBFNV+L2hUp1rHADufV3IMtnDRdf1r5NINEl0=');
        expect(data.zip_hash).toBe('h1:FEBLx1zS214owpjy7qsBeixbURkuhQAwrK5UwLGTwt4=');
        expect(data.pseudo_version).toBe(false);
        expect(data.versionsurl).toBeDefined();
        expect(data.self).toContain('/goregistries/github.com/modules/pkg%3Aerrors');
        expect(data.createdat <= data.modifiedat).toBe(true);

        const followed = await getJson(data.self);
        expect(followed.status).toBe(200);
        expect(followed.data.moduleid).toBe('pkg:errors');

        const versions = await getJson(data.versionsurl);
        expect(versions.status).toBe(200);
        expect(versions.data['v0.9.1']).toBeDefined();
    });

    it('GET module for a root-domain path uses the reserved @ moduleid', async () => {
        const { data, status } = await getJson(`${baseUrl}/goregistries/example.com/modules/%40`);
        expect(status).toBe(200);
        expect(data.moduleid).toBe('@');
        expect(data.name).toBe('example.com');
        expect(data.modulepath).toBe('example.com');
    });

    it('GET module preserves major-version suffixes and module-wide metadata', async () => {
        const { data, status } = await getJson(`${baseUrl}/goregistries/example.com/modules/m:v2`);
        expect(status).toBe(200);
        expect(data.moduleid).toBe('m:v2');
        expect(data.modulepath).toBe('example.com/m/v2');
        expect(data.meta.major_version_suffix).toBe('/v2');
        expect(data.meta.deprecated_message).toBe('use example.com/m/v3 instead.');
        expect(data.meta.retractions).toEqual([
            { low: 'v2.0.0', high: 'v2.0.0', rationale: 'bad release', declared_in: 'v2.1.0' },
            { low: 'v2.0.5', high: 'v2.0.7', rationale: 'wrong branch', declared_in: 'v2.1.0' },
        ]);
        expect(data.go_version).toBe('1.21.0');
        expect(data.toolchain).toBe('go1.21.4');
        expect(data.require).toEqual([
            { path: 'github.com/pkg/errors', version: 'v0.9.1', indirect: true },
            { path: 'golang.org/x/net', version: 'v0.0.0-20210405180319-a5a99cb37ef4' },
        ]);
        expect(data.replace).toEqual([
            { old_path: 'github.com/pkg/errors', new_path: 'github.com/pkg/errors', new_version: 'v0.9.1' },
            { old_path: 'example.com/old', new_path: '../local/old' },
        ]);
        expect(data.exclude).toEqual([{ path: 'github.com/legacy/lib', version: 'v1.2.3' }]);
        expect(data.retract).toEqual([
            { low: 'v2.0.0', high: 'v2.0.0', rationale: 'bad release' },
            { low: 'v2.0.5', high: 'v2.0.7', rationale: 'wrong branch' },
        ]);
        expect(data.godebug).toEqual({ panicnil: '1' });
        expect(data.tool).toEqual(['golang.org/x/tools/cmd/stringer']);
        expect(data.ignore).toEqual(['testdata/generated']);
    });

    it('GET single version returns version record with canonical version and transliterated versionid', async () => {
        const { data, status } = await getJson(
            `${baseUrl}/goregistries/example.com/modules/legacy/versions/v2.0.0~incompatible`
        );
        expect(status).toBe(200);
        expect(data.versionid).toBe('v2.0.0~incompatible');
        expect(data.version).toBe('v2.0.0+incompatible');
        expect(data.incompatible).toBe(true);
        expect(data.zip_hash).toBe('h1:MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM=');
        expect(data.gomod_hash).toBeUndefined();
        expect(data.self).toContain('/goregistries/example.com/modules/legacy/versions/v2.0.0~incompatible');
        expect(data.createdat <= data.modifiedat).toBe(true);
    });

    it('GET module versions collection returns transliterated version IDs', async () => {
        const { data, status, headers } = await getJson(
            `${baseUrl}/goregistries/example.com/modules/legacy/versions`
        );
        expect(status).toBe(200);
        expect(data.self).toBeUndefined();
        expect(data.versionscount).toBeUndefined();
        expect(data.versionsurl).toBeUndefined();
        expect(data['v2.0.0~incompatible']).toBeDefined();
        expect(data['v2.0.0~incompatible'].version).toBe('v2.0.0+incompatible');
        expect(headers.get('x-total-count')).toBe('1');
    });

    it('GET upper-case module path works through the canonical xRegistry identity', async () => {
        const { data, status } = await getJson(
            `${baseUrl}/goregistries/github.com/modules/Case:Module`
        );
        expect(status).toBe(200);
        expect(data.modulepath).toBe('github.com/Case/Module');
        expect(data.moduleid).toBe('Case:Module');
    });

    it('GET hashed collision route resolves to the canonical module path', async () => {
        const moduleCollection = await getJson(`${baseUrl}/goregistries/github.com/modules`);
        const hashedId = Object.keys(moduleCollection.data).find((key) => key.startsWith('xh~'));
        expect(hashedId).toBeDefined();

        const { data, status } = await getJson(`${baseUrl}/goregistries/github.com/modules/${hashedId}`);
        expect(status).toBe(200);
        expect(data.modulepath).toBe('github.com/case/module');
    });

    it('omits unknown version timestamps instead of inventing current values', async () => {
        const { data, status } = await getJson(
            `${baseUrl}/goregistries/example.com/modules/unknown-time/versions/v1.0.0`
        );
        expect(status).toBe(200);
        expect(data.createdat).toBeUndefined();
        expect(data.modifiedat).toBeUndefined();
        expect(data.timestamp).toBeUndefined();
    });

    it('GET unknown module returns 404', async () => {
        const { status } = await getJson(
            `${baseUrl}/goregistries/github.com/modules/does:not-exist`
        );
        expect(status).toBe(404);
    });

    it('rejects malformed group/resource identities', async () => {
        const { status, data } = await getJson(
            `${baseUrl}/goregistries/github.com/modules/does::not-exist`
        );
        expect(status).toBe(400);
        expect(data.title).toBe('Invalid Go module group/resource identity');
    });
});
