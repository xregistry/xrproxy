import express from 'express';
import * as http from 'http';
import * as net from 'net';
import { createPackageRoutes } from '../src/routes/packages';
import { createXRegistryRoutes } from '../src/routes/xregistry';
import { xregistryErrorHandler } from '../src/middleware/xregistry-error-handler';

function getFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.listen(0, () => {
            const address = server.address() as net.AddressInfo;
            server.close(() => resolve(address.port));
        });
        server.on('error', reject);
    });
}

async function getJson(url: string): Promise<{ status: number; data: any; headers: Headers }> {
    const response = await fetch(url);
    const text = await response.text();
    return {
        status: response.status,
        data: text ? JSON.parse(text) : undefined,
        headers: response.headers
    };
}

describe('Maven routes', () => {
    let server: http.Server;
    let baseUrl: string;

    beforeAll(async () => {
        const registryService = {
            getRegistry: jest.fn(async (_req, res) => res.json({ javanamespacesurl: 'http://example.test/javanamespaces' })),
            getModel: jest.fn(async (_req, res) => res.json({ groups: { javanamespaces: {} } })),
            getCapabilities: jest.fn(async (_req, res) => res.json({ specversions: ['1.0-rc2'] })),
            getGroups: jest.fn(async (_req, res) => res.json({ 'org.example': { javanamespaceid: 'org.example' } })),
            getGroup: jest.fn(async (req, res) => res.json({ javanamespaceid: req.params.groupId, group_id: req.params.groupId }))
        };

        const packageService = {
            getAllPackages: jest.fn(async () => ({
                packages: {
                    demo: {
                        packageid: 'demo',
                        xid: '/javanamespaces/org.example/packages/demo',
                        self: 'http://example.test/javanamespaces/org.example/packages/demo',
                        epoch: 1,
                        createdat: '2024-01-01T00:00:00.000Z',
                        modifiedat: '2024-01-01T00:00:00.000Z',
                        group_id: 'org.example',
                        artifact_id: 'demo'
                    }
                },
                totalCount: 1
            })),
            getPackage: jest.fn(async (_namespaceId, packageId, baseUrlArg) => ({
                packageid: packageId,
                xid: `/javanamespaces/org.example/packages/${packageId}`,
                self: `${baseUrlArg}/javanamespaces/org.example/packages/${packageId}`,
                epoch: 1,
                createdat: '2024-01-01T00:00:00.000Z',
                modifiedat: '2024-01-01T00:00:00.000Z',
                versionid: '1.0.0',
                versionsurl: `${baseUrlArg}/javanamespaces/org.example/packages/${packageId}/versions`,
                versionscount: 2,
                group_id: 'org.example',
                artifact_id: 'demo'
            })),
            getPackageVersions: jest.fn(async () => ({
                versions: {
                    '1.0.0': {
                        packageid: 'demo',
                        versionid: '1.0.0',
                        xid: '/javanamespaces/org.example/packages/demo/versions/1.0.0',
                        self: 'http://example.test/javanamespaces/org.example/packages/demo/versions/1.0.0',
                        epoch: 1
                    }
                },
                totalCount: 1
            })),
            getVersion: jest.fn(async (_namespaceId, packageId, versionId, baseUrlArg) => ({
                packageid: packageId,
                versionid: versionId,
                xid: `/javanamespaces/org.example/packages/${packageId}/versions/${versionId}`,
                self: `${baseUrlArg}/javanamespaces/org.example/packages/${packageId}/versions/${versionId}`,
                epoch: 1,
                group_id: 'org.example',
                artifact_id: 'demo'
            }))
        };

        const app = express();
        app.use('/', createXRegistryRoutes({ registryService: registryService as any }));
        app.use('/', createPackageRoutes({ packageService: packageService as any }));
        app.use(xregistryErrorHandler as express.ErrorRequestHandler);

        const port = await getFreePort();
        server = http.createServer(app);
        await new Promise<void>((resolve) => server.listen(port, resolve));
        baseUrl = `http://localhost:${port}`;
    });

    afterAll(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('serves namespace collection routes under /javanamespaces', async () => {
        const response = await getJson(`${baseUrl}/javanamespaces`);
        expect(response.status).toBe(200);
        expect(response.data['org.example']).toEqual({ javanamespaceid: 'org.example' });
    });

    it('serves package collection routes under /javanamespaces/{id}/packages', async () => {
        const response = await getJson(`${baseUrl}/javanamespaces/org.example/packages`);
        expect(response.status).toBe(200);
        expect(response.data['demo'].xid).toBe('/javanamespaces/org.example/packages/demo');
        expect(response.headers.get('x-total-count')).toBe('1');
    });

    it('serves version routes under /javanamespaces/{id}/packages/{id}/versions/{id}', async () => {
        const response = await getJson(`${baseUrl}/javanamespaces/org.example/packages/demo/versions/1.0.0`);
        expect(response.status).toBe(200);
        expect(response.data.xid).toBe('/javanamespaces/org.example/packages/demo/versions/1.0.0');
    });

    it('serves package meta under the namespace path', async () => {
        const response = await getJson(`${baseUrl}/javanamespaces/org.example/packages/demo/meta`);
        expect(response.status).toBe(200);
        expect(response.data.xid).toBe('/javanamespaces/org.example/packages/demo/meta');
        expect(response.data.defaultversionurl).toBe(`${baseUrl}/javanamespaces/org.example/packages/demo/versions/1.0.0`);
    });
});
