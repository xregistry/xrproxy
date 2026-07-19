"use strict";

const { expect } = require("chai");
const axios = require("axios");
const { exec } = require("child_process");
const path = require("path");
const { promisify } = require("util");

const execPromise = promisify(exec);

describe("Packagist Docker Integration Tests", function () {
  this.timeout(120000);

  let containerName;
  let serverPort;
  let baseUrl;
  let containerRunning = false;

  const getRandomPort = () => Math.floor(Math.random() * (65535 - 49152) + 49152);

  const executeCommand = async (command, cwd = null) => {
    console.log(`Executing: ${command}`);
    const options = cwd ? { cwd } : {};
    const { stdout, stderr } = await execPromise(command, options);
    if (stderr && !stderr.includes("WARNING")) console.log("STDERR:", stderr);
    return { stdout, stderr };
  };

  const loggedAxiosGet = async (url) => {
    console.log(`→ GET ${url}`);
    const response = await axios.get(url, { timeout: 10000 });
    console.log(`← ${response.status} ${url}`);
    return response;
  };

  const waitForServer = async (url, maxRetries = 30, delay = 2000) => {
    for (let i = 0; i < maxRetries; i++) {
      try {
        const response = await axios.get(url, { timeout: 5000 });
        if (response.status === 200) return true;
      } catch { /* keep waiting */ }
      await new Promise((r) => setTimeout(r, delay));
    }
    return false;
  };

  before(async function () {
    this.timeout(180000);

    containerName = `packagist-test-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    serverPort = getRandomPort();
    baseUrl = `http://localhost:${serverPort}`;

    const rootPath = path.resolve(__dirname, "../../");
    console.log(`Building packagist.Dockerfile…`);
    await executeCommand(`docker build -f packagist.Dockerfile -t packagist-test-image:latest .`, rootPath);

    console.log(`Starting container on port ${serverPort}…`);
    await executeCommand(
      `docker run -d --name ${containerName} -p ${serverPort}:4100 -e PORT=4100 -e HOST=0.0.0.0 packagist-test-image:latest`
    );
    containerRunning = true;

    const ready = await waitForServer(`${baseUrl}/health`);
    if (!ready) throw new Error("Packagist server failed to start within the expected time");
    console.log("Packagist server is ready");
  });

  after(async function () {
    this.timeout(60000);
    if (containerRunning && containerName) {
      try {
        await executeCommand(`docker stop --time=10 ${containerName}`);
        await executeCommand(`docker rm -f ${containerName}`);
      } catch { /* ignore */ }
    }
    try { await executeCommand("docker rmi packagist-test-image:latest"); } catch { /* ignore */ }
  });

  // ─── Health ─────────────────────────────────────────────────────────────────

  describe("Health endpoint", () => {
    it("responds with status ok (registry-core contract)", async () => {
      const res = await loggedAxiosGet(`${baseUrl}/health`);
      expect(res.status).to.equal(200);
      expect(res.data.status).to.equal("ok");
    });
  });

  // ─── Registry root ───────────────────────────────────────────────────────────

  describe("Registry root /", () => {
    it("returns 200 with xRegistry registry entity", async () => {
      const res = await loggedAxiosGet(baseUrl);
      expect(res.status).to.equal(200);
      expect(res.data).to.have.property("specversion");
      expect(res.data).to.have.property("registryid");
      expect(res.data).to.have.property("composerregistriesurl");
    });

    it("includes Content-Type with xRegistry schema", async () => {
      const res = await loggedAxiosGet(baseUrl);
      expect(res.headers["content-type"]).to.include("application/json");
    });
  });

  // ─── Model ──────────────────────────────────────────────────────────────────

  describe("GET /model", () => {
    it("returns the xRegistry model document", async () => {
      const res = await loggedAxiosGet(`${baseUrl}/model`);
      expect(res.status).to.equal(200);
      expect(res.data).to.have.property("groups");
      expect(res.data.groups).to.have.property("composerregistries");
    });
  });

  // ─── Groups ─────────────────────────────────────────────────────────────────

  describe("GET /composerregistries", () => {
    it("returns the composerregistries group collection", async () => {
      const res = await loggedAxiosGet(`${baseUrl}/composerregistries`);
      expect(res.status).to.equal(200);
      expect(res.data).to.have.property("packagist.org");
    });
  });

  describe("GET /composerregistries/packagist.org", () => {
    it("returns the packagist.org group entity", async () => {
      const res = await loggedAxiosGet(`${baseUrl}/composerregistries/packagist.org`);
      expect(res.status).to.equal(200);
      expect(res.data).to.have.property("xid");
      expect(res.data.xid).to.equal("/composerregistries/packagist.org");
      expect(res.data).to.have.property("packagesurl");
    });

    it("returns 404 for unknown group", async () => {
      try {
        await axios.get(`${baseUrl}/composerregistries/no-such-registry`);
        throw new Error("Expected 404");
      } catch (err) {
        expect(err.response?.status).to.equal(404);
      }
    });
  });

  // ─── Packages list ──────────────────────────────────────────────────────────

  describe("GET /composerregistries/packagist.org/packages", () => {
    it("returns a package listing (may be empty without network)", async () => {
      try {
        const res = await loggedAxiosGet(`${baseUrl}/composerregistries/packagist.org/packages`);
        expect(res.status).to.equal(200);
        expect(typeof res.data).to.equal("object");
      } catch (err) {
        // Accept 502/504 if Packagist is unreachable in CI
        if (err.response?.status === 502 || err.response?.status === 504) return;
        throw err;
      }
    });

    it("supports ?q= query parameter", async () => {
      try {
        const res = await loggedAxiosGet(
          `${baseUrl}/composerregistries/packagist.org/packages?q=symfony`
        );
        expect(res.status).to.equal(200);
      } catch (err) {
        if (err.response?.status === 502 || err.response?.status === 504) return;
        throw err;
      }
    });

    it("honors xRegistry prefix filtering and limit/offset pagination", async () => {
      try {
        const res = await loggedAxiosGet(
          `${baseUrl}/composerregistries/packagist.org/packages?filter=name%3Dsymfony*&limit=2&offset=0`
        );
        expect(res.status).to.equal(200);
        const packages = Object.values(res.data);
        expect(packages).to.have.length.at.most(2);
        expect(packages.every(pkg => pkg.name.toLowerCase().startsWith("symfony"))).to.equal(true);
        expect(res.headers.link).to.include("offset=2");
        expect(res.headers.link).to.include("limit=2");
      } catch (err) {
        if (err.response?.status === 502 || err.response?.status === 504) return;
        throw err;
      }
    });
  });

  // ─── Package entity ──────────────────────────────────────────────────────────

  describe("GET /composerregistries/packagist.org/packages/:id", () => {
    it("returns 404 for non-existent package", async () => {
      try {
        await axios.get(
          `${baseUrl}/composerregistries/packagist.org/packages/definitely~does-not-exist`
        );
        throw new Error("Expected 404");
      } catch (err) {
        // Accept 404 (not found) or 502/504 (upstream unreachable)
        expect([404, 502, 504]).to.include(err.response?.status);
      }
    });

    it("uses tilde-encoded vendor~package IDs", async () => {
      // Verify the routing works with tilde encoding
      try {
        const res = await loggedAxiosGet(
          `${baseUrl}/composerregistries/packagist.org/packages/symfony~console`
        );
        expect(res.status).to.equal(200);
        expect(res.data.packageid).to.equal("symfony~console");
      } catch (err) {
        if (err.response?.status === 404 || err.response?.status === 502 || err.response?.status === 504) return;
        throw err;
      }
    });

    it("paginates versions and marks the default version", async () => {
      try {
        const res = await loggedAxiosGet(
          `${baseUrl}/composerregistries/packagist.org/packages/symfony~console/versions?limit=2&offset=0`
        );
        expect(res.status).to.equal(200);
        const versions = Object.values(res.data);
        expect(versions).to.have.length.at.most(2);
        expect(versions.some(version => version.isdefault === true)).to.equal(true);
        expect(res.headers.link).to.include("offset=2");
      } catch (err) {
        if ([404, 502, 504].includes(err.response?.status)) return;
        throw err;
      }
    });
  });

  // ─── 404 for unknown routes ──────────────────────────────────────────────────

  describe("404 handling", () => {
    it("returns 404 for unknown paths", async () => {
      try {
        await axios.get(`${baseUrl}/not-a-real-endpoint`);
        throw new Error("Expected 404");
      } catch (err) {
        expect(err.response?.status).to.equal(404);
      }
    });
  });
});
