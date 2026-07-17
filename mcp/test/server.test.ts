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
                `http://127.0.0.1:${port}/mcpproviders/ac.inference.sh/servers/ac.inference.sh_mcp`,
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
});
