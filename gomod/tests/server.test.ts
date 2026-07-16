/**
 * Integration-style tests for the Go Module proxy server.
 *
 * Fully deterministic: the upstream GOPROXY is a fixture HTTP server from
 * @xregistry/registry-core, and its URL is injected into GoModuleService via
 * the constructor (never via process.env). No real network calls are made.
 */

import * as http from 'http';
import * as net from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import express from 'express';
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

// ---------------------------------------------------------------------------
// Fixture data (deterministic, checked into the repo)
// ---------------------------------------------------------------------------
interface FixtureModule {
    path: string;
    escapedPath?: string;
    version: string;
    timestamp: string;
    infoResponse: { Version: string; Time: string };
    gomod?: string;
}

function loadFixtureModules(): FixtureModule[] {
    const file = path.join(__dirname, '..', 'fixtures', 'modules.json');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as { modules: FixtureModule[] };
    return parsed.modules;
}

/** Build GOPROXY fixture routes for the given catalog of module versions. */
function buildProxyRoutes(entries: Array<{ path: string; version: string; info: { Version: string; Time: string } }>): FixtureRoute[] {
    const routes: FixtureRoute[] = [];
    const latestByPath = new Map<string, { Version: string; Time: string }>();
    for (const e of entries) {
        const ep = escapePath(e.path);
        const ev = escapeVersion(e.version);
        routes.push({ method: 'GET', path: `/${ep}/@v/${ev}.info`, responses: [{ body: e.info }] });
        routes.push({
            method: 'GET',
            path: `/${ep}/@v/${ev}.mod`,
            responses: [{ headers: { 'content-type': 'text/plain' }, body: `module ${e.path}\n` }],
        });
        const prev = latestByPath.get(e.path);
        if (!prev || e.info.Time > prev.Time) latestByPath.set(e.path, e.info);
    }
    // Per-module @latest and @v/list endpoints.
    const versionsByPath = new Map<string, string[]>();
    for (const e of entries) {
        const arr = versionsByPath.get(e.path) ?? [];
        arr.push(e.version);
        versionsByPath.set(e.path, arr);
    }
    for (const [p, info] of latestByPath) {
        routes.push({ method: 'GET', path: `/${escapePath(p)}/@latest`, responses: [{ body: info }] });
    }
    for (const [p, versions] of versionsByPath) {
        routes.push({
            method: 'GET',
            path: `/${escapePath(p)}/@v/list`,
            responses: [{ headers: { 'content-type': 'text/plain' }, body: versions.join('\n') + '\n' }],
        });
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

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------
describe('Go Module Proxy Server', () => {
    let server: http.Server;
    let baseUrl: string;
    let tmpDir: string;
    let fixture: FixtureServer;

    beforeAll(async () => {
        const fixtures = loadFixtureModules();

        // Seed the catalog with two versions of errors and mux so pagination,
        // versionscount and latest_version are exercised deterministically.
        const catalogEntries = [
            { path: 'github.com/pkg/errors', version: 'v0.9.0', timestamp: '2019-09-09T00:00:00Z', info: { Version: 'v0.9.0', Time: '2019-09-09T00:00:00Z' } },
            { path: 'github.com/pkg/errors', version: 'v0.9.1', timestamp: '2020-01-14T15:33:02Z', info: { Version: 'v0.9.1', Time: '2020-01-14T15:33:02Z' } },
            { path: 'github.com/gorilla/mux', version: 'v1.8.0', timestamp: '2020-08-03T00:00:00Z', info: { Version: 'v1.8.0', Time: '2020-08-03T00:00:00Z' } },
            { path: 'github.com/gorilla/mux', version: 'v1.8.1', timestamp: '2023-05-10T12:00:00Z', info: { Version: 'v1.8.1', Time: '2023-05-10T12:00:00Z' } },
        ];
        // Also register fixture routes for every module in the fixture file.
        const fixtureEntries = fixtures.map(f => ({ path: f.path, version: f.version, info: f.infoResponse }));

        fixture = await startFixtureServer(buildProxyRoutes([...catalogEntries, ...fixtureEntries]));

        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gomod-srv-test-'));
        const cp = new CheckpointService(tmpDir);
        cp.mergeEntries(catalogEntries.map(e => ({ path: e.path, version: e.version, timestamp: e.timestamp })));
        cp.updateCheckpoint('2023-05-10T12:00:00Z');

        // Inject the fixture URL at construction — no process.env, no real network.
        const goSvc = new GoModuleService(cp, {
            proxyBaseUrl: fixture.url,
            indexBaseUrl: fixture.url,
        });
        const entityState = new EntityStateManager();
        const moduleSvc = new ModuleService(goSvc, cp, entityState);
        const registrySvc = new RegistryService(cp, entityState);

        const app = express();
        app.use(corsMiddleware);
        app.use(express.json());
        app.use('/', createXRegistryRoutes(registrySvc));
        app.use('/', createModuleRoutes(moduleSvc, cp));
        app.use(xregistryErrorHandler as express.ErrorRequestHandler);

        const port = await getFreePort();
        server = http.createServer(app);
        await new Promise<void>((resolve) => server.listen(port, resolve));
        baseUrl = `http://localhost:${port}`;
    });

    afterAll(async () => {
        if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
        if (fixture) await fixture.close();
        if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('GET / returns xRegistry root', async () => {
        const { data, status } = await getJson(`${baseUrl}/`);
        expect(status).toBe(200);
        expect(data.specversion).toBe('1.0-rc2');
        expect(data.registryid).toBe('gomod-proxy');
        expect(data.goregistriesurl).toBeDefined();
        expect(data.goregistriescount).toBe(1);
    });

    it('GET /model returns the model', async () => {
        const { data, status } = await getJson(`${baseUrl}/model`);
        expect(status).toBe(200);
        expect(data.groups?.goregistries).toBeDefined();
        expect(data.groups.goregistries.resources?.modules).toBeDefined();
    });

    it('GET /capabilities returns capabilities', async () => {
        const { data, status } = await getJson(`${baseUrl}/capabilities`);
        expect(status).toBe(200);
        expect(Array.isArray(data.specversions)).toBe(true);
    });

    it('GET /goregistries returns group collection', async () => {
        const { data, status } = await getJson(`${baseUrl}/goregistries`);
        expect(status).toBe(200);
        expect(data['pkg.go.dev']).toBeDefined();
    });

    it('GET /goregistries/pkg.go.dev returns group detail', async () => {
        const { data, status } = await getJson(`${baseUrl}/goregistries/pkg.go.dev`);
        expect(status).toBe(200);
        expect(data.goregistryid).toBe('pkg.go.dev');
        expect(typeof data.modulescount).toBe('number');
    });

    it('GET /goregistries/pkg.go.dev/modules returns module list', async () => {
        const { data, status } = await getJson(`${baseUrl}/goregistries/pkg.go.dev/modules`);
        expect(status).toBe(200);
        expect(data['github.com/pkg/errors']).toBeDefined();
    });

    it('GET /goregistries/pkg.go.dev/modules supports pagination', async () => {
        const { data, headers } = await getJson(`${baseUrl}/goregistries/pkg.go.dev/modules?limit=1&offset=0`);
        const moduleKeys = Object.keys(data).filter(
            (k) => !k.endsWith('url') && !k.endsWith('count') && k !== 'self'
        );
        expect(moduleKeys).toHaveLength(1);
        expect(headers.get('x-total-count')).toBeDefined();
    });

    it('GET module by encoded path returns module record', async () => {
        const { data, status } = await getJson(
            `${baseUrl}/goregistries/pkg.go.dev/modules/${encodeURIComponent('github.com/pkg/errors')}`
        );
        expect(status).toBe(200);
        expect(data.moduleid).toBe('github.com/pkg/errors');
        expect(data.latest_version).toBe('v0.9.1');
        expect(data.pseudo_version).toBe(false);
        expect(data.versionsurl).toBeDefined();
    });

    it('GET single version returns version record', async () => {
        const { data, status } = await getJson(
            `${baseUrl}/goregistries/pkg.go.dev/modules/${encodeURIComponent('github.com/pkg/errors')}/versions/v0.9.1`
        );
        expect(status).toBe(200);
        expect(data.versionid).toBe('v0.9.1');
        expect(data.version).toBe('v0.9.1');
        expect(data.info_url).toContain('v0.9.1.info');
        expect(data.mod_url).toContain('v0.9.1.mod');
        expect(data.zip_url).toContain('v0.9.1.zip');
        expect(data.pseudo_version).toBe(false);
    });

    it('GET module versions collection returns versions', async () => {
        const { data, status } = await getJson(
            `${baseUrl}/goregistries/pkg.go.dev/modules/${encodeURIComponent('github.com/pkg/errors')}/versions`
        );
        expect(status).toBe(200);
        expect(data.versionscount).toBe(2);
        expect(data['v0.9.0']).toBeDefined();
        expect(data['v0.9.1']).toBeDefined();
    });

    it('GET unknown module returns 404', async () => {
        const { status } = await getJson(
            `${baseUrl}/goregistries/pkg.go.dev/modules/${encodeURIComponent('github.com/does/not-exist')}`
        );
        expect(status).toBe(404);
    });
});
