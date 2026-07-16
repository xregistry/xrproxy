'use strict';

const { expect } = require('chai');
const axios = require('axios');
const { exec } = require('child_process');
const { promisify } = require('util');

const execPromise = promisify(exec);

const GROUP = 'huggingfaceregistries';
const REGISTRY = 'huggingface.co';

describe('Hugging Face Docker Integration Tests', function () {
  this.timeout(180_000);

  let containerName;
  let serverPort;
  let baseUrl;
  let containerRunning = false;

  const getRandomPort = () => Math.floor(Math.random() * (65535 - 49152) + 49152);

  const executeCommand = async cmd => {
    const { stdout, stderr } = await execPromise(cmd);
    return { stdout: stdout.trim(), stderr: stderr.trim() };
  };

  const waitForServer = async (url, maxRetries = 30, delay = 2000) => {
    for (let i = 0; i < maxRetries; i++) {
      try {
        const response = await axios.get(url, { timeout: 5000 });
        if (response.status === 200) return true;
      } catch (_) {
        // not ready yet
      }
      await new Promise(resolve => setTimeout(resolve, delay));
    }
    return false;
  };

  before(async function () {
    containerName = `hf-test-${Date.now()}`;
    serverPort = getRandomPort();
    baseUrl = `http://localhost:${serverPort}`;

    await executeCommand(
      `docker build -f huggingface.Dockerfile -t xregistry-hf-test:local .`
    );

    await executeCommand(
      `docker run -d --name ${containerName} -p ${serverPort}:4300 ` +
      `-e PORT=4300 -e HOST=0.0.0.0 ` +
      `xregistry-hf-test:local`
    );
    containerRunning = true;

    const ready = await waitForServer(`${baseUrl}/health`);
    if (!ready) throw new Error('Server did not start in time');
  });

  after(async function () {
    if (containerRunning) {
      try { await executeCommand(`docker stop ${containerName}`); } catch (_) {}
      try { await executeCommand(`docker rm -f ${containerName}`); } catch (_) {}
    }
  });

  it('GET /health → 200', async () => {
    const res = await axios.get(`${baseUrl}/health`);
    expect(res.status).to.equal(200);
    expect(res.data.status).to.equal('ok');
  });

  it('GET /model → huggingfaceregistries group', async () => {
    const res = await axios.get(`${baseUrl}/model`);
    expect(res.status).to.equal(200);
    expect(res.data.groups).to.have.property('huggingfaceregistries');
  });

  it('GET / → registry document with huggingfaceregistriesurl', async () => {
    const res = await axios.get(`${baseUrl}/`);
    expect(res.status).to.equal(200);
    expect(res.data).to.have.property('huggingfaceregistriesurl');
    expect(res.data.huggingfaceregistriescount).to.equal(1);
  });

  it('GET / with Authorization header → 400', async () => {
    try {
      await axios.get(`${baseUrl}/`, { headers: { Authorization: 'Bearer secret' } });
      throw new Error('Expected 400');
    } catch (err) {
      expect(err.response?.status).to.equal(400);
    }
  });

  it(`GET /${GROUP} → group collection`, async () => {
    const res = await axios.get(`${baseUrl}/${GROUP}`);
    expect(res.status).to.equal(200);
    expect(res.data).to.have.property(REGISTRY);
  });

  it(`GET /${GROUP}/${REGISTRY} → group document`, async () => {
    const res = await axios.get(`${baseUrl}/${GROUP}/${REGISTRY}`);
    expect(res.status).to.equal(200);
    expect(res.data.huggingfaceregistryid).to.equal(REGISTRY);
  });

  it(`GET /${GROUP}/${REGISTRY}/models → 200 (live HF API)`, async () => {
    const res = await axios.get(`${baseUrl}/${GROUP}/${REGISTRY}/models?limit=5`);
    expect(res.status).to.equal(200);
    const keys = Object.keys(res.data);
    expect(keys.length).to.be.greaterThan(0);
    // Verify xRegistry structure
    const first = res.data[keys[0]];
    expect(first).to.have.property('modelid');
    expect(first).to.have.property('xid');
    expect(first).to.have.property('repoid');
  });

  it(`GET /${GROUP}/${REGISTRY}/models/bert-base-uncased → model doc`, async () => {
    const res = await axios.get(`${baseUrl}/${GROUP}/${REGISTRY}/models/bert-base-uncased`);
    expect(res.status).to.equal(200);
    expect(res.data.modelid).to.equal('bert-base-uncased');
    expect(res.data.repoid).to.equal('bert-base-uncased');
    expect(res.data).to.have.property('sha');
    expect(res.data).to.have.property('versionsurl');
  });

  it('version list has mutable cache header (max-age <= 300)', async () => {
    const res = await axios.get(
      `${baseUrl}/${GROUP}/${REGISTRY}/models/bert-base-uncased/versions`
    );
    expect(res.status).to.equal(200);
    const cc = res.headers['cache-control'] ?? '';
    expect(cc).to.match(/max-age=(\d+)/);
    const match = cc.match(/max-age=(\d+)/);
    if (match) {
      expect(parseInt(match[1], 10)).to.be.at.most(300);
    }
  });

  it(`GET /${GROUP}/${REGISTRY}/datasets → 200`, async () => {
    const res = await axios.get(`${baseUrl}/${GROUP}/${REGISTRY}/datasets?limit=3`);
    expect(res.status).to.equal(200);
  });

  it(`GET /${GROUP}/${REGISTRY}/spaces → 200`, async () => {
    const res = await axios.get(`${baseUrl}/${GROUP}/${REGISTRY}/spaces?limit=3`);
    expect(res.status).to.equal(200);
  });

  it(`GET /${GROUP}/unknown → 404`, async () => {
    try {
      await axios.get(`${baseUrl}/${GROUP}/unknown`);
      throw new Error('Expected 404');
    } catch (err) {
      expect(err.response?.status).to.equal(404);
    }
  });
});
