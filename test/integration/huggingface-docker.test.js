'use strict';

const { expect } = require('chai');
const axios = require('axios');
const { exec } = require('child_process');
const { promisify } = require('util');

const execPromise = promisify(exec);
const { assertCapabilitiesConform } = require("../helpers/xregistry-capability-conformance.cjs");

const GROUP = 'huggingfaceregistries';

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
    const models = res.data.groups.huggingfaceregistries.resources.models;
    expect(models.attributes).to.have.property('versionid');
    expect(models.metaattributes).to.have.property('defaultversionurl');
    const source = await axios.get(`${baseUrl}/modelsource`);
    expect(Object.keys(source.data)).to.deep.equal(["groups"]);
    expect(source.data).not.to.have.property("default");
    expect(res.data).not.to.have.property("default");
    expect(source.data.groups.huggingfaceregistries.resources.models).not.to.have.property('resourceattributes');
  });

  it("GET /capabilities satisfies the rc2 schema and runtime profile", async () => {
    const res = await axios.get(`${baseUrl}/capabilities`);
    expect(res.status).to.equal(200);
    assertCapabilitiesConform(res.data, { flags: ["filter"], versionmodes: ["manual"] });
  });

  it('GET / → registry document with huggingfaceregistriesurl', async () => {
    const res = await axios.get(`${baseUrl}/`);
    expect(res.status).to.equal(200);
    expect(res.data).to.have.property('huggingfaceregistriesurl');
    if ('huggingfaceregistriescount' in res.data) expect(res.data.huggingfaceregistriescount).to.be.greaterThan(0);
  });

  it('GET / with Authorization header → 400', async () => {
    try {
      await axios.get(`${baseUrl}/`, { headers: { Authorization: 'Bearer secret' } });
      throw new Error('Expected 400');
    } catch (err) {
      expect(err.response?.status).to.equal(400);
    }
  });

  it(`GET /${GROUP} returns bounded native owner groups`, async () => {
    const res = await axios.get(`${baseUrl}/${GROUP}?limit=2`);
    expect(res.status).to.equal(200);
    expect(Object.keys(res.data).length).to.be.at.most(2);
    for (const [id, group] of Object.entries(res.data)) {
      expect(group.huggingfaceregistryid).to.equal(id);
    }
    expect(res.headers).to.have.property('x-collection-complete');
  });

  it(`GET /${GROUP}/google-bert returns group detail`, async () => {
    const res = await axios.get(`${baseUrl}/${GROUP}/google-bert`);
    expect(res.status).to.equal(200);
    expect(res.data.huggingfaceregistryid).to.equal('google-bert');
  });

  it(`GET /${GROUP}/google-bert/models → 200 (live HF API)`, async () => {
    const res = await axios.get(`${baseUrl}/${GROUP}/google-bert/models?limit=5`);
    expect(res.status).to.equal(200);
    const keys = Object.keys(res.data);
    expect(keys.length).to.be.greaterThan(0);
    // Verify xRegistry structure
    const first = res.data[keys[0]];
    expect(first).to.have.property('modelid');
    expect(first).to.have.property('xid');
    expect(first).to.have.property('repoid');
    expect(first).to.have.property('versionid');
    expect(first).to.have.property('ancestor');
    expect(first).to.have.property('metaurl');
    expect(first).not.to.have.property('defaultversionurl');
  });

  it('resource meta follows the mutable upstream default', async () => {
    const res = await axios.get(`${baseUrl}/${GROUP}/google-bert/models/bert-base-uncased/meta`);
    expect(res.status).to.equal(200);
    expect(res.data.defaultversionsticky).to.equal(false);
    expect(res.data).to.have.property('defaultversionid');
  });

  it(`GET /${GROUP}/google-bert/models/bert-base-uncased → model doc`, async () => {
    const res = await axios.get(`${baseUrl}/${GROUP}/google-bert/models/bert-base-uncased`);
    expect(res.status).to.equal(200);
    expect(res.data.modelid).to.equal('bert-base-uncased');
    expect(res.data.repository).to.equal('google-bert/bert-base-uncased');
    expect(res.data).to.have.property('sha');
    expect(res.data).to.have.property('versionsurl');
    expect(res.data).to.have.property('ancestor');
  });

  it('canonical bare aliases do not create an unnamespaced duplicate', async () => {
    try {
      await axios.get(`${baseUrl}/${GROUP}/_/models/gpt2`, { maxRedirects: 0, timeout: 30_000 });
      throw new Error('Expected canonical redirect');
    } catch (err) {
      expect(err.response?.status).to.equal(308);
      expect(new URL(err.response.headers.location).pathname).to.equal(`/${GROUP}/openai-community/models/gpt2`);
    }
  });

  it('version list has mutable cache header (max-age <= 300)', async () => {
    const res = await axios.get(
      `${baseUrl}/${GROUP}/google-bert/models/bert-base-uncased/versions`
    );
    expect(res.status).to.equal(200);
    const cc = res.headers['cache-control'] ?? '';
    expect(cc).to.match(/max-age=(\d+)/);
    const match = cc.match(/max-age=(\d+)/);
    if (match) {
      expect(parseInt(match[1], 10)).to.be.at.most(300);
    }
  });

  it(`GET /${GROUP}/rajpurkar/datasets → 200`, async () => {
    const res = await axios.get(`${baseUrl}/${GROUP}/rajpurkar/datasets?limit=3`);
    expect(res.status).to.equal(200);
  });

  it(`GET /${GROUP}/gradio/spaces/hello_world → 200`, async () => {
    const res = await axios.get(`${baseUrl}/${GROUP}/gradio/spaces/hello_world`);
    expect(res.status).to.equal(200);
  });

  it('returns 410 for removed fixed-group identities', async () => {
    try {
      await axios.get(`${baseUrl}/${GROUP}/huggingface.co/models/google-bert~bert-base-uncased`);
      throw new Error('Expected 410');
    } catch (err) {
      expect(err.response?.status).to.equal(410);
    }
  });

  it('encoded legacy paths still return 410', async () => {
    try {
      await axios.get(`${baseUrl}/${GROUP}/%68uggingface.co/models/google-bert%7Ebert-base-uncased/meta`);
      throw new Error('Expected 410');
    } catch (err) {
      expect(err.response?.status).to.equal(410);
      expect(err.response?.data.replacement).to.equal(`/${GROUP}/google-bert/models/bert-base-uncased/meta`);
    }
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
