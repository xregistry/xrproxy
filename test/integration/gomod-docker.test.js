'use strict';

const { expect } = require('chai');
const axios = require('axios');
const { exec } = require('child_process');
const path = require('path');

const execAsync = (...args) => new Promise((resolve, reject) => {
    exec(...args, (err, stdout, stderr) => {
        if (err) reject(Object.assign(err, { stdout, stderr }));
        else resolve({ stdout, stderr });
    });
});

describe('Go Module Proxy Docker Integration Tests', function () {
    this.timeout(180000);

    let containerName;
    let serverPort;
    let baseUrl;
    let containerRunning = false;

    const getRandomPort = () => Math.floor(Math.random() * (65535 - 49152) + 49152);

    const loggedGet = async (url) => {
        console.log(`  → GET ${url}`);
        const response = await axios.get(url, { timeout: 10000 });
        console.log(`  ← ${response.status} ${url}`);
        return response;
    };

    const run = (cmd, cwd) => {
        console.log(`  $ ${cmd}`);
        return execAsync(cmd, cwd ? { cwd } : {});
    };

    const waitForServer = async (url, retries = 30, delay = 3000) => {
        for (let i = 0; i < retries; i++) {
            try {
                const { status } = await axios.get(url, { timeout: 5000 });
                if (status === 200) return true;
            } catch (_) {
                // not ready yet
            }
            await new Promise((r) => setTimeout(r, delay));
        }
        return false;
    };

    before(async function () {
        this.timeout(300000);
        containerName = `gomod-test-${Date.now()}`;
        serverPort = getRandomPort();
        baseUrl = `http://localhost:${serverPort}`;

        const rootPath = path.resolve(__dirname, '../../');
        console.log('Building Go Module Proxy Docker image…');
        await run(`docker build -f gomod.Dockerfile -t gomod-test-image:latest .`, rootPath);

        console.log(`Starting container ${containerName} on port ${serverPort}…`);
        await run(
            `docker run -d --name ${containerName} ` +
            `-p ${serverPort}:3900 ` +
            `-e PORT=3900 -e HOST=0.0.0.0 ` +
            `gomod-test-image:latest`
        );
        containerRunning = true;

        console.log('Waiting for server to be ready…');
        const ready = await waitForServer(`${baseUrl}/health`);
        if (!ready) {
            const { stdout } = await run(`docker logs ${containerName}`).catch(() => ({ stdout: '' }));
            console.log('Container logs:\n', stdout);
            throw new Error('Go Module Proxy server failed to start within the expected time');
        }
        console.log('Server ready ✓');
    });

    after(async function () {
        this.timeout(60000);
        if (containerRunning && containerName) {
            await run(`docker stop --time=10 ${containerName}`).catch(() => {});
            await run(`docker rm -f ${containerName}`).catch(() => {});
        }
        await run('docker rmi gomod-test-image:latest').catch(() => {});
    });

    // -----------------------------------------------------------------------
    // Health
    // -----------------------------------------------------------------------
    describe('Health endpoint', () => {
        it('GET /health returns healthy', async () => {
            const { data, status } = await loggedGet(`${baseUrl}/health`);
            expect(status).to.equal(200);
            expect(data.status).to.equal('healthy');
            expect(data).to.have.property('catalog');
        });
    });

    // -----------------------------------------------------------------------
    // xRegistry meta
    // -----------------------------------------------------------------------
    describe('xRegistry meta endpoints', () => {
        it('GET / returns xRegistry root with specversion 1.0-rc2', async () => {
            const { data, status } = await loggedGet(`${baseUrl}/`);
            expect(status).to.equal(200);
            expect(data.specversion).to.equal('1.0-rc2');
            expect(data.registryid).to.equal('gomod-proxy');
            expect(data).to.have.property('goregistriesurl');
            expect(data).to.have.property('goregistriescount');
        });

        it('GET /model returns model with goregistries', async () => {
            const { data, status } = await loggedGet(`${baseUrl}/model`);
            expect(status).to.equal(200);
            expect(data.groups).to.have.property('goregistries');
            expect(data.groups.goregistries.resources).to.have.property('modules');
        });

        it('GET /capabilities returns standard capabilities', async () => {
            const { data, status } = await loggedGet(`${baseUrl}/capabilities`);
            expect(status).to.equal(200);
            expect(data.specversions).to.include('1.0-rc2');
            expect(data.pagination).to.equal(true);
        });
    });

    // -----------------------------------------------------------------------
    // Group endpoints
    // -----------------------------------------------------------------------
    describe('Group endpoints', () => {
        it('GET /goregistries returns native module namespaces', async () => {
            const { data, status } = await loggedGet(`${baseUrl}/goregistries`);
            expect(status).to.equal(200);
            expect(data).not.to.have.property('pkg.go.dev');
            for (const groupId of Object.keys(data)) {
                expect(groupId).to.match(/^[^/]+\.[^/]+$/);
            }
        });

        it('GET /goregistries/github.com returns namespace detail', async () => {
            const { data, status } = await loggedGet(`${baseUrl}/goregistries/github.com`);
            expect(status).to.equal(200);
            expect(data.goregistryid).to.equal('github.com');
            expect(data).to.have.property('modulesurl');
        });
    });

    // -----------------------------------------------------------------------
    // Module collection
    // -----------------------------------------------------------------------
    describe('Module collection', () => {
        it('GET /goregistries/github.com/modules returns a collection', async () => {
            const { data, headers, status } = await loggedGet(`${baseUrl}/goregistries/github.com/modules`);
            expect(status).to.equal(200);
            expect(headers).to.have.property('x-total-count');
            expect(data).not.to.have.property('modulescount');
            expect(data).not.to.have.property('modulesurl');
            expect(Object.keys(data)).not.to.include('self');
        });

        it('supports limit/offset pagination', async () => {
            const { data, status } = await loggedGet(
                `${baseUrl}/goregistries/github.com/modules?limit=5&offset=0`
            );
            expect(status).to.equal(200);
        });
    });

    // -----------------------------------------------------------------------
    // 404 handling
    // -----------------------------------------------------------------------
    describe('404 handling', () => {
        it('returns 404 for unknown module', async () => {
            try {
                await loggedGet(
                    `${baseUrl}/goregistries/github.com/modules/does:not-exist-xyz-123`
                );
                throw new Error('Expected 404');
            } catch (err) {
                expect(err.response?.status ?? err.message).to.equal(404);
            }
        });

        it('returns 404 for unknown path', async () => {
            try {
                await loggedGet(`${baseUrl}/unknown-endpoint-xyz`);
                throw new Error('Expected 404');
            } catch (err) {
                expect(err.response?.status ?? err.message).to.equal(404);
            }
        });
    });
});
