const axios = require("axios");
const chai = require("chai");
const expect = chai.expect;
const { spawn } = require("child_process");
const path = require("path");

// Replaces the previous sqlite-integration.test.js. The maven server no
// longer ships an embedded SQLite catalog; it queries Maven Central's
// Solr API directly. For deterministic CI runs we drive it in stub mode
// via MAVEN_USE_TEST_INDEX=true, which serves a 10-row in-memory fixture
// (see maven/src/services/stub-catalog.ts).

describe("Maven Stub-Mode Integration", function () {
  this.timeout(60000);

  let serverProcess;
  const serverPort = 3009;
  const baseUrl = `http://localhost:${serverPort}`;

  before(async function () {
    this.timeout(45000);
    console.log("Starting xRegistry Maven server in stub mode...");
    serverProcess = await startServer(serverPort);
    await waitForServer(baseUrl, 35000);
    console.log("Maven server (stub mode) is ready");
  });

  after(function (done) {
    if (!serverProcess) return done();
    let cleanupCompleted = false;
    const completeCleanup = () => {
      if (!cleanupCompleted) {
        cleanupCompleted = true;
        done();
      }
    };

    serverProcess.on("exit", completeCleanup);
    serverProcess.on("error", completeCleanup);

    serverProcess.kill("SIGTERM");
    setTimeout(() => {
      if (serverProcess && !serverProcess.killed && !cleanupCompleted) {
        serverProcess.kill("SIGKILL");
        setTimeout(completeCleanup, 1000);
      }
    }, 8000);
  });

  describe("Package listing", function () {
    it("returns packages with basic pagination", async function () {
      const response = await axios.get(
        `${baseUrl}/javaregistries/maven-central/packages?limit=3`
      );

      expect(response.status).to.equal(200);
      expect(response.data).to.be.an("object");

      const packages = Object.keys(response.data);
      expect(packages.length).to.equal(3);

      const firstPackage = response.data[packages[0]];
      expect(firstPackage).to.have.property("name");
      expect(firstPackage).to.have.property("groupId");
      expect(firstPackage).to.have.property("artifactId");
      expect(firstPackage).to.have.property("self");
      // versionscount should now reflect the real (stub) Solr versionCount
      // field rather than the legacy hardcoded 1.
      expect(firstPackage.versionscount).to.be.greaterThan(1);
    });

    it("supports pagination with offset", async function () {
      const response = await axios.get(
        `${baseUrl}/javaregistries/maven-central/packages?limit=1&offset=1`
      );

      expect(response.status).to.equal(200);
      const packages = Object.keys(response.data);
      expect(packages.length).to.equal(1);
    });

    it("supports filtering by name", async function () {
      const response = await axios.get(
        `${baseUrl}/javaregistries/maven-central/packages?filter=${encodeURIComponent("name='junit'")}&limit=5`
      );

      expect(response.status).to.equal(200);
      const packages = Object.keys(response.data);
      // 'junit' substring matches both junit:junit and org.junit.jupiter:junit-jupiter-api in the stub.
      expect(packages.length).to.be.greaterThan(0);
      packages.forEach((id) => expect(id.toLowerCase()).to.include("junit"));
    });

    it("supports sorting by name", async function () {
      const response = await axios.get(
        `${baseUrl}/javaregistries/maven-central/packages?sort=name&limit=3`
      );

      expect(response.status).to.equal(200);
      const packages = Object.keys(response.data);
      if (packages.length >= 2) {
        const a = packages[0].split(":")[1] || packages[0];
        const b = packages[1].split(":")[1] || packages[1];
        expect(a.localeCompare(b, undefined, { sensitivity: "base" })).to.be.lessThanOrEqual(0);
      }
    });

    it("rejects invalid limit with 400", async function () {
      try {
        await axios.get(`${baseUrl}/javaregistries/maven-central/packages?limit=0`);
        expect.fail("expected 400");
      } catch (error) {
        expect(error.response.status).to.equal(400);
        expect(error.response.data).to.have.property("detail");
        expect(error.response.data.detail).to.include("positive integer");
      }
    });

    it("responds quickly under concurrent load", async function () {
      const requests = Array(5)
        .fill(null)
        .map((_, i) =>
          axios.get(
            `${baseUrl}/javaregistries/maven-central/packages?limit=2&offset=${i}`
          )
        );

      const startTime = Date.now();
      const responses = await Promise.all(requests);
      const duration = Date.now() - startTime;

      responses.forEach((response) => {
        expect(response.status).to.equal(200);
      });
      // Stub mode is in-memory; 15s is generous and matches the prior
      // SQLite-backed budget.
      expect(duration).to.be.lessThan(15000);
    });
  });

  describe("Group resource counts", function () {
    it("/javaregistries/maven-central reports the live packagescount", async function () {
      const response = await axios.get(
        `${baseUrl}/javaregistries/maven-central`
      );
      expect(response.status).to.equal(200);
      // Stub catalog ships 10 entries.
      expect(response.data.packagescount).to.equal(10);
    });
  });

  async function startServer(port) {
    return new Promise((resolve, reject) => {
      const serverPath = path.join(__dirname, "../../maven/dist/maven/src/server.js");
      const proc = spawn(
        "node",
        [serverPath, "--port", String(port), "--quiet"],
        {
          env: {
            ...process.env,
            NODE_ENV: "test",
            MAVEN_USE_TEST_INDEX: "true"
          },
          stdio: ["pipe", "pipe", "pipe"]
        }
      );

      let hasStarted = false;

      proc.stdout.on("data", (data) => {
        const output = data.toString();
        console.log("Server stdout:", output.trim());
        if (
          (output.includes("Service started") ||
            output.includes("server started") ||
            output.includes("Server listening")) &&
          !hasStarted
        ) {
          hasStarted = true;
          resolve(proc);
        }
      });

      proc.stderr.on("data", (data) => {
        const errorOutput = data.toString();
        console.log("Server stderr:", errorOutput.trim());
        if (errorOutput.includes("EADDRINUSE") && !hasStarted) {
          reject(new Error(`port in use: ${errorOutput}`));
        }
      });

      proc.on("error", (error) => {
        if (!hasStarted) reject(error);
      });

      proc.on("exit", (code) => {
        if (code !== 0 && !hasStarted) {
          reject(new Error(`Server exited with code ${code}`));
        }
      });

      const fallback = setTimeout(() => {
        if (!hasStarted && !proc.killed) {
          hasStarted = true;
          resolve(proc);
        }
      }, 15000);

      setTimeout(() => {
        if (!hasStarted) {
          clearTimeout(fallback);
          proc.kill();
          reject(new Error("Server startup timeout"));
        }
      }, 30000);
    });
  }

  async function waitForServer(url, timeout = 15000) {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      try {
        const response = await axios.get(`${url}/`);
        if (response.status === 200) return;
      } catch {
        // not ready
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`Server at ${url} did not become ready within ${timeout}ms`);
  }
});
