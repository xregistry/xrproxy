import axios from 'axios';
import { createServer as createHttpServer } from 'http';
import { AddressInfo, createServer } from 'net';
import { XRegistryServer } from '../src/server';

async function getAvailablePort(): Promise<number> {
    const probe = createServer();

    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));

    return port;
}

describe('XRegistryServer', () => {
    it('serves non-inline registry metadata without waiting for catalog warm-up', async () => {
        const port = await getAvailablePort();
        const server = new XRegistryServer({
            port,
            host: '127.0.0.1',
            mcpRegistryUrl: 'http://127.0.0.1:1'
        });

        try {
            await server.start();
            const response = await axios.get(`http://127.0.0.1:${port}`, { timeout: 1000 });

            expect(response.status).toBe(200);
            expect(response.data.mcpproviderscount).toBe(0);
        } finally {
            await server.stop();
        }
    });

    it('returns a gateway timeout instead of not found when the upstream times out', async () => {
        const upstreamPort = await getAvailablePort();
        const upstream = createHttpServer((_req, res) => {
            setTimeout(() => {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ servers: [] }));
            }, 100);
        });
        await new Promise<void>((resolve) => upstream.listen(upstreamPort, '127.0.0.1', resolve));

        const port = await getAvailablePort();
        const server = new XRegistryServer({
            port,
            host: '127.0.0.1',
            mcpRegistryUrl: `http://127.0.0.1:${upstreamPort}`,
            upstreamTimeout: 10
        });

        try {
            await server.start();
            const response = await axios.get(
                `http://127.0.0.1:${port}/mcpproviders/ac.inference.sh/servers/mcp`,
                { timeout: 1000, validateStatus: () => true }
            );

            expect(response.status).toBe(504);
            expect(response.data).toEqual({
                error: 'Gateway timeout',
                message: 'MCP Registry request timed out'
            });
        } finally {
            await server.stop();
            await new Promise<void>((resolve, reject) =>
                upstream.close((error) => error ? reject(error) : resolve())
            );
        }
    });

    it('returns resource metadata under meta and omits runtime capability fields', async () => {
        const port = await getAvailablePort();
        const server = new XRegistryServer({
            port,
            host: '127.0.0.1',
            mcpRegistryUrl: 'http://127.0.0.1:1'
        });

        const latestVersion = {
            server: {
                name: 'ac.inference.sh/mcp',
                version: '1.0.0+build.5',
                description: 'Inference server',
                websiteUrl: 'https://example.com/mcp',
                packages: [{
                    registryType: 'npm',
                    identifier: '@scope/package',
                    transport: { type: 'stdio' },
                }],
                _meta: {
                    'io.modelcontextprotocol.registry/publisher-provided': {
                        tier: 'gold',
                    },
                },
                tools: [{ name: 'should-not-surface' }],
            },
            _meta: {
                'io.modelcontextprotocol.registry/official': {
                    status: 'deprecated',
                    statusMessage: 'Use the hosted endpoint',
                    statusChangedAt: '2025-01-02T00:00:00Z',
                    publishedAt: '2025-01-01T00:00:00Z',
                    updatedAt: '2025-01-03T00:00:00Z',
                    isLatest: true,
                },
            },
        } as any;

        const olderVersion = {
            server: {
                name: 'ac.inference.sh/mcp',
                version: '0.9.0',
                description: 'Inference server',
            },
            _meta: {
                'io.modelcontextprotocol.registry/official': {
                    status: 'active',
                    publishedAt: '2024-12-01T00:00:00Z',
                    updatedAt: '2024-12-01T00:00:00Z',
                    isLatest: false,
                },
            },
        } as any;

        const service = (server as any).mcpService;
        jest.spyOn(service, 'getAllServers').mockResolvedValue({
            servers: [latestVersion],
            metadata: { count: 1 },
        });
        jest.spyOn(service, 'resolveServerVersions').mockResolvedValue({
            servers: [latestVersion, olderVersion],
            metadata: { count: 2 },
        });

        try {
            await server.start();

            const resourceResponse = await axios.get(
                `http://127.0.0.1:${port}/mcpproviders/ac.inference.sh/servers/mcp?inline=versions`,
                { timeout: 1000 }
            );

            expect(resourceResponse.status).toBe(200);
            expect(resourceResponse.data.serverid).toBe('mcp');
            expect(resourceResponse.data.versionid).toBe('1.0.0~build.5');
            expect(resourceResponse.data.name).toBe('ac.inference.sh/mcp');
            expect(resourceResponse.data.website_url).toBe('https://example.com/mcp');
            expect(resourceResponse.data.publisher_meta).toEqual({ tier: 'gold' });
            expect(resourceResponse.data.meta).toMatchObject({
                status: 'deprecated',
                status_message: 'Use the hosted endpoint',
                status_changed_at: '2025-01-02T00:00:00Z',
                published_at: '2025-01-01T00:00:00Z',
                updated_at: '2025-01-03T00:00:00Z',
                is_latest: true,
                defaultversionid: '1.0.0~build.5',
                defaultversionsticky: true,
            });
            expect(resourceResponse.data.versions['1.0.0~build.5']).toBeDefined();
            expect(resourceResponse.data.versions['1.0.0~build.5']).not.toHaveProperty('meta');
            expect(resourceResponse.data.versions['1.0.0~build.5'].self).toContain('/versions/1.0.0~build.5');
            expect(resourceResponse.data.packages[0].packagexid).toBe('/nodescopes/scope/packages/package');
            expect(resourceResponse.data).not.toHaveProperty('tools');

            const metaResponse = await axios.get(
                `http://127.0.0.1:${port}/mcpproviders/ac.inference.sh/servers/mcp/meta`,
                { timeout: 1000 }
            );

            expect(metaResponse.status).toBe(200);
            expect(metaResponse.data).toMatchObject({
                xid: '/mcpproviders/ac.inference.sh/servers/mcp/meta',
                defaultversionid: '1.0.0~build.5',
                status_message: 'Use the hosted endpoint',
                defaultversionsticky: true,
            });

            const versionsResponse = await axios.get(
                `http://127.0.0.1:${port}/mcpproviders/ac.inference.sh/servers/mcp/versions`,
                { timeout: 1000 }
            );

            expect(versionsResponse.status).toBe(200);
            expect(Object.keys(versionsResponse.data)).toEqual(expect.arrayContaining(['1.0.0~build.5', '0.9.0']));
            expect(versionsResponse.data['1.0.0~build.5'].ancestor).toBe('/mcpproviders/ac.inference.sh/servers/mcp');
        } finally {
            await server.stop();
        }
    });
});
