/**
 * Terraform Docker Integration Tests
 * Builds the terraform.Dockerfile, starts a container, and validates xRegistry endpoints.
 */

const { expect } = require("chai");
const axios = require("axios");
const { exec } = require("child_process");
const { promisify } = require("util");

const execPromise = promisify(exec);

describe("Terraform Docker Integration Tests", function () {
  this.timeout(180000); // 3 min

  let containerName;
  let serverPort;
  let baseUrl;
  let containerRunning = false;

  const getRandomPort = () => Math.floor(Math.random() * (65535 - 49152) + 49152);

  const executeCommand = async (cmd) => {
    try {
      return await execPromise(cmd);
    } catch (err) {
      throw new Error(`Command failed: ${cmd}\n${err.message}`);
    }
  };

  const waitForServer = async (url, maxRetries = 30, delay = 2000) => {
    for (let i = 0; i < maxRetries; i++) {
      try {
        const r = await axios.get(url, { timeout: 5000 });
        if (r.status === 200) return true;
      } catch {
        /* keep trying */
      }
      await new Promise((r) => setTimeout(r, delay));
    }
    return false;
  };

  before(async function () {
    this.timeout(120000);
    containerName = `terraform-test-${Date.now()}`;
    serverPort = getRandomPort();
    baseUrl = `http://localhost:${serverPort}`;

    console.log(`Building terraform.Dockerfile…`);
    await executeCommand(`docker build -f terraform.Dockerfile -t ${containerName}-img .`);

    console.log(`Starting container on port ${serverPort}…`);
    await executeCommand(
      `docker run -d --name ${containerName} -p ${serverPort}:3800 ${containerName}-img`
    );
    containerRunning = true;

    const ready = await waitForServer(`${baseUrl}/health`);
    if (!ready) throw new Error("Terraform server did not become ready in time");
    console.log("Terraform server is ready");
  });

  after(async function () {
    if (containerRunning) {
      await execPromise(`docker stop ${containerName}`).catch(() => {});
      await execPromise(`docker rm ${containerName}`).catch(() => {});
    }
    await execPromise(`docker rmi ${containerName}-img`).catch(() => {});
  });

  // ------------------------------------------------------------------
  // Root and structural endpoints
  // ------------------------------------------------------------------
  describe("Core xRegistry endpoints", () => {
    it("GET / returns a valid registry root", async () => {
      const r = await axios.get(`${baseUrl}/`);
      expect(r.status).to.equal(200);
      expect(r.data).to.have.property("specversion", "1.0-rc2");
      expect(r.data).to.have.property("registryid", "terraform-registry-wrapper");
      expect(r.data).to.have.property("xid", "/");
      expect(r.data).to.have.property("terraformregistriesurl");
      expect(r.data).to.have.property("terraformregistriescount", 1);
    });

    it("GET /model returns the model document", async () => {
      const r = await axios.get(`${baseUrl}/model`);
      expect(r.status).to.equal(200);
      // model is wrapped: response.model.groups.terraformregistries
      const trg = r.data.model?.groups?.terraformregistries ?? r.data.groups?.terraformregistries;
      expect(trg).to.exist;
      expect(trg).to.have.nested.property("resources.providers");
      expect(trg).to.have.nested.property("resources.modules");
    });

    it("GET /capabilities reports read-only with filter/sort/pagination", async () => {
      const r = await axios.get(`${baseUrl}/capabilities`);
      expect(r.status).to.equal(200);
      expect(r.data).to.have.property("mutable", false);
      expect(r.data).to.have.property("filter", true);
      expect(r.data).to.have.property("pagination", true);
    });

    it("GET /terraformregistries returns the registry.terraform.io group", async () => {
      const r = await axios.get(`${baseUrl}/terraformregistries`);
      expect(r.status).to.equal(200);
      expect(r.data).to.have.property("registry.terraform.io");
    });

    it("GET /terraformregistries/registry.terraform.io returns group detail", async () => {
      const r = await axios.get(`${baseUrl}/terraformregistries/registry.terraform.io`);
      expect(r.status).to.equal(200);
      expect(r.data).to.have.property("providersurl");
      expect(r.data).to.have.property("modulesurl");
    });
  });

  // ------------------------------------------------------------------
  // Provider endpoints
  // ------------------------------------------------------------------
  describe("Provider endpoints", () => {
    const providersBase = "/terraformregistries/registry.terraform.io/providers";

    it("GET /providers returns a collection", async () => {
      const r = await axios.get(`${baseUrl}${providersBase}`, { timeout: 30000 });
      expect(r.status).to.equal(200);
      expect(r.data).to.be.an("object");
    });

    it("GET /providers/hashicorp~aws returns provider metadata", async () => {
      const r = await axios.get(`${baseUrl}${providersBase}/hashicorp~aws`, { timeout: 30000 });
      expect(r.status).to.equal(200);
      expect(r.data).to.have.property("providerid", "hashicorp~aws");
      expect(r.data).to.have.property("namespace", "hashicorp");
      expect(r.data).to.have.property("type", "aws");
      expect(r.data).to.have.property("versionsurl");
      expect(r.data).to.have.property("versionscount");
      expect(r.data.versionscount).to.be.a("number").and.to.be.greaterThan(0);
    });

    it("GET /providers/hashicorp~aws/versions returns version map", async () => {
      const r = await axios.get(`${baseUrl}${providersBase}/hashicorp~aws/versions`, { timeout: 30000 });
      expect(r.status).to.equal(200);
      const versions = Object.keys(r.data);
      expect(versions.length).to.be.greaterThan(0);
      const anyVersion = r.data[versions[0]];
      expect(anyVersion).to.have.property("versionid");
      expect(anyVersion).to.have.property("providerid", "hashicorp~aws");
    });

    it("GET /providers/hashicorp~aws/versions/latest exposes platform distributions", async () => {
      // Get versions first to pick one
      const versionsResp = await axios.get(`${baseUrl}${providersBase}/hashicorp~aws/versions`, { timeout: 30000 });
      const versionIds = Object.keys(versionsResp.data);
      const latestId = versionIds[0];

      const r = await axios.get(`${baseUrl}${providersBase}/hashicorp~aws/versions/${latestId}`, { timeout: 60000 });
      expect(r.status).to.equal(200);
      expect(r.data).to.have.property("platforms");
      const platforms = r.data.platforms;
      expect(Array.isArray(platforms)).to.be.true;
      expect(platforms.length).to.be.greaterThan(0);
      const p = platforms[0];
      expect(p).to.have.property("os");
      expect(p).to.have.property("arch");
      // signing_keys may be present
      if (r.data.signing_keys) {
        expect(r.data.signing_keys).to.have.property("gpg_public_keys");
      }
    });

    it("GET /providers/hashicorp~aws/meta returns meta sub-resource", async () => {
      const r = await axios.get(`${baseUrl}${providersBase}/hashicorp~aws/meta`, { timeout: 30000 });
      expect(r.status).to.equal(200);
      expect(r.data).to.have.property("readonly", true);
      expect(r.data).to.have.property("defaultversionid");
    });

    it("GET /providers/unknown~provider returns 404", async () => {
      try {
        await axios.get(`${baseUrl}${providersBase}/unknown~nonexistent`, { timeout: 15000 });
        expect.fail("Expected 404");
      } catch (err) {
        expect(err.response.status).to.equal(404);
      }
    });

    it("POST /providers returns 405", async () => {
      try {
        await axios.post(`${baseUrl}${providersBase}`, {});
        expect.fail("Expected 405");
      } catch (err) {
        expect(err.response.status).to.equal(405);
      }
    });
  });

  // ------------------------------------------------------------------
  // Module endpoints
  // ------------------------------------------------------------------
  describe("Module endpoints", () => {
    const modulesBase = "/terraformregistries/registry.terraform.io/modules";

    it("GET /modules returns a collection", async () => {
      const r = await axios.get(`${baseUrl}${modulesBase}`, { timeout: 30000 });
      expect(r.status).to.equal(200);
      expect(r.data).to.be.an("object");
    });

    it("GET /modules/terraform-aws-modules~vpc~aws returns module metadata", async () => {
      const r = await axios.get(`${baseUrl}${modulesBase}/terraform-aws-modules~vpc~aws`, { timeout: 30000 });
      expect(r.status).to.equal(200);
      expect(r.data).to.have.property("moduleid", "terraform-aws-modules~vpc~aws");
      expect(r.data).to.have.property("namespace", "terraform-aws-modules");
      expect(r.data).to.have.property("name", "vpc");
      expect(r.data).to.have.property("provider", "aws");
      expect(r.data).to.have.property("versionsurl");
    });

    it("GET /modules/terraform-aws-modules~vpc~aws/versions returns version map", async () => {
      const r = await axios.get(`${baseUrl}${modulesBase}/terraform-aws-modules~vpc~aws/versions`, { timeout: 30000 });
      expect(r.status).to.equal(200);
      const versions = Object.keys(r.data);
      expect(versions.length).to.be.greaterThan(0);
      const v = r.data[versions[0]];
      expect(v).to.have.property("versionid");
      expect(v).to.have.property("moduleid", "terraform-aws-modules~vpc~aws");
    });

    it("GET /modules/unknown~mod~aws returns 404", async () => {
      try {
        await axios.get(`${baseUrl}${modulesBase}/unknown~nonexistent~aws`, { timeout: 15000 });
        expect.fail("Expected 404");
      } catch (err) {
        expect(err.response.status).to.equal(404);
      }
    });
  });

  // ------------------------------------------------------------------
  // Pagination and filtering
  // ------------------------------------------------------------------
  describe("Pagination and filtering", () => {
    const providersBase = "/terraformregistries/registry.terraform.io/providers";

    it("?limit=2&offset=0 returns at most 2 providers", async () => {
      const r = await axios.get(`${baseUrl}${providersBase}?limit=2&offset=0`, { timeout: 30000 });
      expect(r.status).to.equal(200);
      expect(Object.keys(r.data).length).to.be.at.most(2);
    });

    it("Link header is present when results span multiple pages", async () => {
      const r = await axios.get(`${baseUrl}${providersBase}?limit=1&offset=0`, { timeout: 30000 });
      expect(r.status).to.equal(200);
      if (Object.keys(r.data).length > 0) {
        // Link header should be present if there are more pages
        const total = parseInt((r.headers['link'] || '').match(/count="(\d+)"/) ?.[1] || '0', 10);
        if (total > 1) {
          expect(r.headers['link']).to.include('rel="next"');
        }
      }
    });
  });

  // ------------------------------------------------------------------
  // Health endpoint
  // ------------------------------------------------------------------
  describe("Health endpoint", () => {
    it("GET /health returns ok status", async () => {
      const r = await axios.get(`${baseUrl}/health`);
      expect(r.status).to.equal(200);
      expect(r.data).to.have.property("status", "ok");
    });
  });
});
