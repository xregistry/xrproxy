import { createServer as createHttpServer, Server } from 'http';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { XRegistryServer } from '../../src/server';

jest.mock('all-the-package-names', () => [
    '-zero',
    '@alpha/a',
    '@alpha/b',
    '@bravo/a',
    '@charlie/a',
    'express',
], { virtual: true });

describe('npm server collection pagination', () => {
    let registry: XRegistryServer;
    let server: Server;
    let baseUrl: string;
    let indexCacheDir: string;

    beforeAll(async () => {
        indexCacheDir = await mkdtemp(path.join(tmpdir(), 'xrproxy-npm-index-'));
        registry = new XRegistryServer({ cacheEnabled: false, indexCacheDir });
        server = createHttpServer(registry.getApp());
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Test server did not bind a TCP port.');
        baseUrl = `http://127.0.0.1:${address.port}`;
    });

    afterAll(async () => {
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        await registry.stop();
        await rm(indexCacheDir, { recursive: true, force: true });
    });

    test('returns a bounded nodescope page with total count and navigation links', async () => {
        const response = await fetch(`${baseUrl}/nodescopes?limit=2&offset=0`);
        const body = await response.json() as Record<string, unknown>;

        expect(response.status).toBe(200);
        expect(Object.keys(body)).toEqual(['_', 'alpha']);
        expect(response.headers.get('x-total-count')).toBe('4');
        expect(response.headers.get('link')).toContain('offset=2');
        expect(response.headers.get('link')).toContain('rel="last"');
    });

    test('pages packages from a scope range without materializing every scope collection', async () => {
        const response = await fetch(`${baseUrl}/nodescopes/alpha/packages?limit=1&offset=1`);
        const body = await response.json() as Record<string, unknown>;

        expect(Object.keys(body)).toEqual(['b']);
        expect(response.headers.get('x-total-count')).toBe('2');
        expect(response.headers.get('link')).toContain('rel="first"');
        expect(response.headers.get('link')).toContain('rel="prev"');
    });

    test('keeps non-contiguous unscoped package segments in the unscoped group', async () => {
        const response = await fetch(`${baseUrl}/nodescopes/_/packages?limit=10`);
        const body = await response.json() as Record<string, unknown>;

        expect(Object.keys(body)).toEqual(['-zero', 'express']);
        expect(response.headers.get('x-total-count')).toBe('2');
    });
});
