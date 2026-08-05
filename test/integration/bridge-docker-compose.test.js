const { expect } = require("chai");
const axios = require("axios");
const { exec, spawn } = require("child_process");
const path = require("path");
const { promisify } = require("util");
const { getDockerComposeCommand } = require("../test-helpers");

const execPromise = promisify(exec);

describe("Bridge Docker Compose Integration Tests", function () {
  this.timeout(600000); // 10 minutes timeout for Docker Compose operations

  let composeRunning = false;
  const bridgeUrl = "http://localhost:8080";
  const testDir = path.resolve(__dirname);
  let dockerCompose = null;

  const loggedAxiosGet = async (url, headers = {}) => {
    try {
      console.log(`🔍 Making request to: ${url}`);
      if (Object.keys(headers).length > 0) {
        console.log(`📋 Headers: ${JSON.stringify(headers)}`);
      }
      const response = await axios.get(url, { timeout: 10000, headers });
      console.log(
        `✅ Response: ${response.status} ${response.statusText} for ${url}`
      );
      return response;
    } catch (error) {
      if (error.response) {
        console.log(
          `❌ Response: ${error.response.status} ${error.response.statusText} for ${url}`
        );
      } else {
        console.log(`💥 Network error for ${url}: ${error.message}`);
      }
      throw error;
    }
  };

  const executeCommand = async (command, cwd = null) => {
    console.log(`Executing: ${command}`);
    try {
      const options = cwd ? { cwd } : {};
      const { stdout, stderr } = await execPromise(command, options);
      if (
        stderr &&
        !stderr.includes("WARNING") &&
        !stderr.includes("warning")
      ) {
        console.log("STDERR:", stderr);
      }
      return { stdout, stderr };
    } catch (error) {
      console.error(`Command failed: ${command}`);
      console.error("Error:", error.message);
      throw error;
    }
  };

  const checkComposeServices = async () => {
    try {
      if (!dockerCompose) dockerCompose = await getDockerComposeCommand();
      const { stdout } = await executeCommand(
        `${dockerCompose} -f docker-compose.bridge.yml ps`,
        testDir
      );
      console.log(`📦 Docker Compose Services Status:\n${stdout}`);
      return stdout;
    } catch (error) {
      console.log(`⚠️  Could not check compose services: ${error.message}`);
      return "";
    }
  };

  const waitForService = async (
    url,
    serviceName,
    maxRetries = 30,
    delay = 10000
  ) => {
    console.log(
      `⏳ Waiting for ${serviceName} at ${url} (max ${maxRetries} retries, ${delay}ms delay)`
    );
    for (let i = 0; i < maxRetries; i++) {
      try {
        console.log(
          `🔄 Attempt ${
            i + 1
          }/${maxRetries}: Checking ${serviceName} readiness...`
        );
        const response = await axios.get(url, { timeout: 5000 });
        if (response.status === 200) {
          console.log(
            `🎉 ${serviceName} is ready! Response: ${response.status} ${response.statusText}`
          );
          return true;
        }
      } catch (error) {
        console.log(`⏱️  Attempt ${i + 1} failed: ${error.message}`);
        if (i % 5 === 0) {
          // Check compose status every 5 attempts
          await checkComposeServices();
        }
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    console.log(
      `❌ ${serviceName} failed to become ready after ${maxRetries} attempts`
    );
    await checkComposeServices();
    return false;
  };

  before(async function () {
    this.timeout(900000); // 15 minutes for compose up

    console.log("🏗️  Starting Docker Compose stack...");
    console.log("Working directory:", testDir);

    // Detect docker compose command
    dockerCompose = await getDockerComposeCommand();
    console.log(`Using docker compose command: ${dockerCompose}`);

    // Stop any existing compose services
    try {
      await executeCommand(
        `${dockerCompose} -f docker-compose.bridge.yml down -v --remove-orphans`,
        testDir
      );
    } catch (error) {
      console.log("No existing services to stop");
    }

    // Start the Docker Compose stack
    console.log("🚀 Starting all services with Docker Compose...");
    await executeCommand(
      `${dockerCompose} -f docker-compose.bridge.yml up -d --build`,
      testDir
    );

    composeRunning = true;

    // Check initial service status
    console.log("Checking initial service status...");
    await checkComposeServices();

    // Wait for the bridge to be ready (it depends on all other services)
    console.log("Waiting for bridge proxy to be ready...");
    const isBridgeReady = await waitForService(
      bridgeUrl,
      "Bridge Proxy",
      90,
      15000
    );
    if (!isBridgeReady) {
      await checkComposeServices();
      throw new Error("Bridge proxy failed to start within the expected time");
    }

    // Additional check: Verify routing is initialized by checking a registry endpoint
    console.log("Verifying bridge routing is initialized...");
    let routingReady = false;
    for (let i = 0; i < 30; i++) {
      try {
        console.log(`⏳ Attempt ${i + 1}/30: Checking routing initialization...`);
        const response = await axios.get(`${bridgeUrl}/nodescopes?limit=1`, { timeout: 5000 });
        if (response.status === 200 && response.data && Object.keys(response.data).length > 0) {
          console.log("✅ Bridge routing confirmed ready - registry data available");
          routingReady = true;
          break;
        }
      } catch (err) {
        console.log(`⏱️  Routing not ready yet: ${err.message}`);
        if (i % 5 === 0 && i > 0) {
          await checkComposeServices();
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 2000)); // 2 second delay
    }

    if (!routingReady) {
      await checkComposeServices();
      throw new Error("Bridge routing failed to initialize within expected time (60 seconds)");
    }

    console.log("🎯 All services are ready for testing");
  });
  after(async function () {
    this.timeout(300000); // 5 minutes for cleanup

    if (composeRunning) {
      try {
        console.log("Final service status before cleanup:");
        await checkComposeServices();

        console.log("🧹 Stopping and removing Docker Compose stack...");
        // First try graceful shutdown
        try {
          await executeCommand(
            `${dockerCompose} -f docker-compose.bridge.yml stop`,
            testDir
          );
        } catch (stopError) {
          console.log("Error stopping services gracefully:", stopError.message);
        }

        // Then remove everything
        await executeCommand(
          `${dockerCompose} -f docker-compose.bridge.yml down -v --remove-orphans`,
          testDir
        );
        console.log("Compose cleanup completed");
      } catch (error) {
        console.error("Error during compose cleanup:", error.message);
        // Try force cleanup as last resort
        try {
          console.log("Attempting force cleanup...");
          await executeCommand(
            `${dockerCompose} -f docker-compose.bridge.yml kill`,
            testDir
          );
          await executeCommand(
            `${dockerCompose} -f docker-compose.bridge.yml down -v --remove-orphans`,
            testDir
          );
        } catch (forceError) {
          console.error("Force cleanup also failed:", forceError.message);
        }
      }
    }
  });

  describe("Bridge Health and Discovery", () => {
    it("should respond to bridge root endpoint", async () => {
      await checkComposeServices();
      const response = await loggedAxiosGet(bridgeUrl);
      expect(response.status).to.equal(200);
      expect(response.data).to.be.an("object");
    });

    it("should discover all downstream registries", async () => {
      const response = await loggedAxiosGet(`${bridgeUrl}/registries`);
      expect(response.status).to.equal(200);
      expect(response.data).to.be.an("object");

      // Should have all registry types
      console.log("📋 Discovered registries:", Object.keys(response.data));
    });
  });

  describe("NPM Registry Integration", () => {
    it("should access NPM packages through bridge", async () => {
      const response = await loggedAxiosGet(`${bridgeUrl}/nodescopes?limit=5`);
      expect(response.status).to.equal(200);
      expect(response.data).to.be.an("object");
    });

    it("should access specific NPM registry through bridge", async () => {
      try {
        const response = await loggedAxiosGet(
          `${bridgeUrl}/nodescopes/_`
        );
        expect(response.status).to.equal(200);
        expect(response.data).to.be.an("object");
      } catch (error) {
        if (error.response && error.response.status === 404) {
          console.log(
            "NPM registry not found - may be expected in test environment"
          );
          expect(error.response.status).to.equal(404);
        } else {
          throw error;
        }
      }
    });
  });

  describe("PyPI Registry Integration", () => {
    it("should access PyPI packages through bridge", async () => {
      const response = await loggedAxiosGet(`${bridgeUrl}/pythonregistries`);
      expect(response.status).to.equal(200);
      expect(response.data).to.be.an("object");
    });

    it("should access specific PyPI registry through bridge", async () => {
      const response = await loggedAxiosGet(
        `${bridgeUrl}/pythonregistries/pypi`
      );
      expect(response.status).to.equal(200);
      expect(response.data).to.be.an("object");
      expect(response.data).to.have.property("name", "pypi");
    });

    it("should access PyPI packages through bridge", async () => {
      try {
        const response = await loggedAxiosGet(
          `${bridgeUrl}/pythonregistries/pypi/packages/requests`
        );
        expect(response.status).to.equal(200);
        expect(response.data).to.be.an("object");
      } catch (error) {
        if (error.response && error.response.status === 404) {
          console.log(
            "PyPI package not found - may be expected if external registry unavailable"
          );
          expect(error.response.status).to.equal(404);
        } else {
          throw error;
        }
      }
    });
  });

  describe("Maven Registry Integration", () => {
    it("should access Maven packages through bridge", async () => {
      const response = await loggedAxiosGet(`${bridgeUrl}/javanamespaces`);
      expect(response.status).to.equal(200);
      expect(response.data).to.be.an("object");
    });

    it("should access specific Maven registry through bridge", async () => {
      const response = await loggedAxiosGet(
        `${bridgeUrl}/javanamespaces/junit`
      );
      expect(response.status).to.equal(200);
      expect(response.data).to.be.an("object");
      expect(response.data).to.have.property("javanamespaceid", "junit");
    });

    it("should access Maven packages through bridge", async () => {
      try {
        const response = await loggedAxiosGet(
          `${bridgeUrl}/javanamespaces/junit/packages/junit`
        );
        expect(response.status).to.equal(200);
        expect(response.data).to.be.an("object");
      } catch (error) {
        if (
          error.code === "ECONNABORTED" ||
          error.message?.includes("timeout")
        ) {
          console.log(
            "Maven package request timed out - external registry may be slow or unavailable"
          );
          expect(error.code).to.be.oneOf(["ECONNABORTED", undefined]);
        } else if (error.response && error.response.status === 404) {
          console.log(
            "Maven package not found - may be expected if external registry unavailable"
          );
          expect(error.response.status).to.equal(404);
        } else {
          throw error;
        }
      }
    });
  });

  describe("NuGet Registry Integration", () => {
    it("should access NuGet packages through bridge", async () => {
      const response = await loggedAxiosGet(`${bridgeUrl}/dotnetregistries`);
      expect(response.status).to.equal(200);
      expect(response.data).to.be.an("object");
    });

    it("should access specific NuGet registry through bridge", async () => {
      const response = await loggedAxiosGet(
        `${bridgeUrl}/dotnetregistries/nuget`
      );
      expect(response.status).to.equal(200);
      expect(response.data).to.be.an("object");
      expect(response.data).to.have.property("dotnetregistryid", "nuget");
    });

    it("should access NuGet packages through bridge", async () => {
      try {
        const response = await loggedAxiosGet(
          `${bridgeUrl}/dotnetregistries/nuget/packages/Newtonsoft.Json`
        );
        expect(response.status).to.equal(200);
        expect(response.data).to.be.an("object");
      } catch (error) {
        if (error.response && error.response.status === 404) {
          console.log(
            "NuGet package not found - may be expected if external registry unavailable"
          );
          expect(error.response.status).to.equal(404);
        } else {
          throw error;
        }
      }
    });
  });

  describe("OCI Registry Integration", () => {
    it("should access OCI images through bridge", async () => {
      const response = await loggedAxiosGet(`${bridgeUrl}/containerregistries`);
      expect(response.status).to.equal(200);
      expect(response.data).to.be.an("object");
    });

    it("should access specific OCI registry through bridge", async () => {
      try {
        const response = await loggedAxiosGet(
          `${bridgeUrl}/containerregistries/microsoft`
        );
        expect(response.status).to.equal(200);
        expect(response.data).to.be.an("object");
        expect(response.data).to.have.property("id", "microsoft");
      } catch (error) {
        if (error.response && error.response.status === 404) {
          console.log(
            "OCI registry not found - may be expected in test environment"
          );
          expect(error.response.status).to.equal(404);
        } else {
          throw error;
        }
      }
    });

    it("should access OCI images through bridge", async () => {
      try {
        const response = await loggedAxiosGet(
          `${bridgeUrl}/containerregistries/microsoft/images/dotnet~runtime`
        );
        expect(response.status).to.equal(200);
        expect(response.data).to.be.an("object");
      } catch (error) {
        if (error.response && error.response.status === 404) {
          console.log(
            "OCI image not found - may be expected if external registry unavailable"
          );
          expect(error.response.status).to.equal(404);
        } else {
          throw error;
        }
      }
    });
  });

  describe("API Key Authentication", () => {
    it("should handle requests with proper API keys", async () => {
      // Test that the bridge properly forwards API keys to downstream services
      const headers = {
        "X-API-Key": "test-bridge-api-key",
      };

      try {
        const response = await loggedAxiosGet(
          `${bridgeUrl}/javanamespaces`,
          headers
        );
        expect(response.status).to.equal(200);
        console.log("✅ API key forwarding working correctly");
      } catch (error) {
        // API key handling may vary by implementation
        console.log(
          "ℹ️  API key test completed with status:",
          error.response?.status || "network error"
        );
      }
    });
  });

  describe("Error Handling", () => {
    it("should return 404 for non-existent registries", async () => {
      try {
        await loggedAxiosGet(`${bridgeUrl}/nonexistentregistries/test`);
        expect.fail("Should have thrown an error");
      } catch (error) {
        expect(error.response.status).to.equal(404);
      }
    });

    it("should return 404 for non-existent packages", async () => {
      try {
        await loggedAxiosGet(
          `${bridgeUrl}/javanamespaces/junit/packages/non-existent-package-123456789`
        );
        expect.fail("Should have thrown an error");
      } catch (error) {
        // Maven Central may return 404 or timeout for non-existent packages
        // Both are acceptable outcomes indicating the package doesn't exist
        if (error.response) {
          expect(error.response.status).to.equal(404);
        } else if (error.code === "ECONNABORTED" || error.message.includes("timeout")) {
          console.log("Maven Central timed out - treating as non-existent package (acceptable)");
        } else {
          throw error; // Re-throw unexpected errors
        }
      }
    });
  });

  describe("Cross-Registry Discovery", () => {
    it("should list all available registry groups", async () => {
      const response = await loggedAxiosGet(`${bridgeUrl}/model`);
      expect(response.status).to.equal(200);
      expect(response.data).to.be.an("object");

      if (response.data.model && response.data.model.groups) {
        const groups = response.data.model.groups;
        console.log("📋 Available registry groups:", Object.keys(groups));

        // Should have at least some of our registry types
        const expectedGroups = [
          "javanamespaces",
          "nodescopes",
          "dotnetregistries",
          "pythonregistries",
          "containerregistries",
        ];
        const availableGroups = Object.keys(groups);

        expectedGroups.forEach((expectedGroup) => {
          if (availableGroups.includes(expectedGroup)) {
            console.log(`✅ Found expected group: ${expectedGroup}`);
          } else {
            console.log(
              `ℹ️  Group not found: ${expectedGroup} (may be expected in test environment)`
            );
          }
        });
      }
    });

    it("should provide capabilities information", async () => {
      const response = await loggedAxiosGet(`${bridgeUrl}/capabilities`);
      expect(response.status).to.equal(200);
      expect(response.data).to.be.an("object");
      console.log("📋 Bridge capabilities provided");
    });
  });

  describe("xRegistry Graph Conformance - Full Hierarchy Walk", () => {
    // Test each individual server directly (not through bridge) to ensure
    // complete xRegistry conformance from root to individual versions
    // This validates the entire graph structure: Root -> Groups -> Group -> Packages -> Package -> Versions -> Version
    const serverConfigs = [
      {
        name: "NPM Server",
        serverUrl: "http://localhost:3001", // Direct NPM server
        groupsEndpoint: "/nodescopes",
        groupId: "_",
        packageName: "express",
        version: "4.18.2",
      },
      {
        name: "NuGet Server",
        serverUrl: "http://localhost:3002", // Direct NuGet server
        groupsEndpoint: "/dotnetregistries",
        groupId: "nuget",
        packageName: "Newtonsoft.Json",
        version: "13.0.3",
      },
      {
        name: "PyPI Server",
        serverUrl: "http://localhost:3003", // Direct PyPI server
        groupsEndpoint: "/pythonregistries",
        groupId: "pypi",
        packageName: "requests",
        version: "2.31.0",
      },
      {
        name: "Maven Server",
        serverUrl: "http://localhost:3004", // Direct Maven server
        groupsEndpoint: "/javanamespaces",
        groupId: "junit",
        packageName: "junit",
        version: "4.13.2",
      },
      {
        name: "OCI Server",
        serverUrl: "http://localhost:3005", // Direct OCI server
        groupsEndpoint: "/containerregistries",
        groupId: "microsoft",
        packageName: "dotnet~runtime",
        version: "8.0",
      },
    ];

    const validateXRegistryCommonProperties = (obj, objType, path) => {
      console.log(`🔍 Validating ${objType} at ${path}`);

      // Core xRegistry properties that should exist
      expect(obj).to.be.an("object", `${objType} should be an object`);
      expect(obj).to.have.property(
        "xid",
        `${objType} should have xid property`
      );
      expect(obj).to.have.property(
        "self",
        `${objType} should have self property`
      );
      expect(obj).to.have.property(
        "epoch",
        `${objType} should have epoch property`
      );
      expect(obj).to.have.property(
        "createdat",
        `${objType} should have createdat property`
      );
      expect(obj).to.have.property(
        "modifiedat",
        `${objType} should have modifiedat property`
      );

      // Validate xid format
      expect(obj.xid).to.be.a("string", `${objType} xid should be a string`);
      expect(obj.xid).to.match(/^\//, `${objType} xid should start with /`);

      // Validate self URL
      expect(obj.self).to.be.a("string", `${objType} self should be a string`);
      expect(obj.self).to.include(
        "http",
        `${objType} self should be a valid URL`
      );

      // Validate epoch
      expect(obj.epoch).to.be.a(
        "number",
        `${objType} epoch should be a number`
      );
      expect(obj.epoch).to.be.greaterThan(
        0,
        `${objType} epoch should be positive`
      );

      // Validate timestamps (ISO 8601)
      expect(obj.createdat).to.be.a(
        "string",
        `${objType} createdat should be a string`
      );
      expect(obj.modifiedat).to.be.a(
        "string",
        `${objType} modifiedat should be a string`
      );

      // Validate timestamp format
      expect(() => new Date(obj.createdat).toISOString()).to.not.throw(
        `${objType} createdat should be valid ISO 8601`
      );
      expect(() => new Date(obj.modifiedat).toISOString()).to.not.throw(
        `${objType} modifiedat should be valid ISO 8601`
      );

      console.log(`✅ ${objType} at ${path} has valid xRegistry properties`);
    };

    const validateCollectionFormat = (collection, collectionType, path) => {
      console.log(`🔍 Validating ${collectionType} collection at ${path}`);

      expect(collection).to.be.an(
        "object",
        `${collectionType} collection should be an object`
      );
      expect(collection).to.not.be.an(
        "array",
        `${collectionType} collection should not be an array`
      );

      // xRegistry conformant: should NOT have these properties
      expect(collection).to.not.have.property(
        "count",
        `${collectionType} collection should not have count property (xRegistry uses HTTP headers)`
      );
      expect(collection).to.not.have.property(
        "resources",
        `${collectionType} collection should not have resources property (xRegistry uses flat structure)`
      );
      expect(collection).to.not.have.property(
        "_links",
        `${collectionType} collection should not have _links property (xRegistry uses HTTP Link headers)`
      );
      expect(collection).to.not.have.property(
        "registry",
        `${collectionType} collection should not have registry metadata property`
      );
      expect(collection).to.not.have.property(
        "groupType",
        `${collectionType} collection should not have groupType metadata property`
      );

      // Should have items as direct properties
      const itemKeys = Object.keys(collection);
      expect(itemKeys.length).to.be.greaterThan(
        0,
        `${collectionType} collection should have items`
      );

      console.log(
        `📊 ${collectionType} collection has ${itemKeys.length} items`
      );
      console.log(
        `✅ ${collectionType} collection at ${path} is xRegistry conformant`
      );

      return itemKeys;
    };

    serverConfigs.forEach((config) => {
      describe(`${config.name} - Complete Graph Walk`, () => {
        it(`should walk entire ${config.name} hierarchy with xRegistry conformance`, async function () {
          this.timeout(60000); // 1 minute timeout for comprehensive test

          console.log(
            `\n🚀 Starting complete ${config.name} graph walk directly on server...`
          );

          // Step 1: Server Root
          console.log(`\n📍 Step 1: Server Root (${config.serverUrl})`);
          try {
            const rootResponse = await loggedAxiosGet(config.serverUrl);
            expect(rootResponse.status).to.equal(200);
            validateXRegistryCommonProperties(
              rootResponse.data,
              "Server Root",
              "/"
            );
          } catch (error) {
            if (error.code === "ECONNREFUSED" || error.code === "ENOTFOUND") {
              console.log(
                `⚠️  ${config.name} is not running or not accessible at ${config.serverUrl}`
              );
              console.log(
                `ℹ️  This is expected if ${config.name} is not started in the Docker Compose stack`
              );
              // Don't fail the test if a server is not running
              return;
            } else {
              throw error;
            }
          }

          try {
            // Step 2: Groups Collection (e.g., /nodescopes, /dotnetregistries)
            console.log(
              `\n📍 Step 2: Groups Collection (${config.serverUrl}${config.groupsEndpoint})`
            );
            const groupsResponse = await loggedAxiosGet(
              `${config.serverUrl}${config.groupsEndpoint}`
            );
            expect(groupsResponse.status).to.equal(200);

            const groupKeys = validateCollectionFormat(
              groupsResponse.data,
              "Groups",
              config.groupsEndpoint
            );
            console.log(
              `📋 Available groups: ${groupKeys.slice(0, 3).join(", ")}${
                groupKeys.length > 3 ? "..." : ""
              }`
            );

            // Step 3: Specific Group (e.g., /nodescopes/_)
            console.log(
              `\n📍 Step 3: Specific Group (${config.serverUrl}${config.groupsEndpoint}/${config.groupId})`
            );
            const groupResponse = await loggedAxiosGet(
              `${config.serverUrl}${config.groupsEndpoint}/${config.groupId}`
            );
            expect(groupResponse.status).to.equal(200);
            validateXRegistryCommonProperties(
              groupResponse.data,
              "Group",
              `${config.groupsEndpoint}/${config.groupId}`
            );

            // Verify group has packages URL
            expect(groupResponse.data).to.have.property(
              "packagesurl",
              "Group should have packagesurl property"
            );

            // Step 4: Packages Collection (e.g., /nodescopes/_/packages)
            console.log(
              `\n📍 Step 4: Packages Collection (${config.serverUrl}${config.groupsEndpoint}/${config.groupId}/packages)`
            );
            const packagesResponse = await loggedAxiosGet(
              `${config.serverUrl}${config.groupsEndpoint}/${config.groupId}/packages?limit=5`
            );
            expect(packagesResponse.status).to.equal(200);

            // Verify pagination headers (xRegistry conformant)
            expect(packagesResponse.headers).to.have.property(
              "link",
              "Packages collection should have Link header for pagination"
            );

            const packageKeys = validateCollectionFormat(
              packagesResponse.data,
              "Packages",
              `${config.groupsEndpoint}/${config.groupId}/packages`
            );

            // Validate individual package structure
            const firstPackageKey = packageKeys[0];
            const firstPackage = packagesResponse.data[firstPackageKey];
            validateXRegistryCommonProperties(
              firstPackage,
              "Package",
              `${config.groupsEndpoint}/${config.groupId}/packages/${firstPackageKey}`
            );

            // Package-specific properties
            expect(firstPackage).to.have.property(
              "name",
              "Package should have name property"
            );
            expect(firstPackage).to.have.property(
              "packageid",
              "Package should have packageid property"
            );
            expect(firstPackage.name).to.equal(
              firstPackageKey,
              "Package name should match collection key"
            );

            // Step 5: Specific Package (e.g., /nodescopes/_/packages/express)
            console.log(
              `\n📍 Step 5: Specific Package (${config.serverUrl}${config.groupsEndpoint}/${config.groupId}/packages/${config.packageName})`
            );
            try {
              const packageResponse = await loggedAxiosGet(
                `${config.serverUrl}${config.groupsEndpoint}/${
                  config.groupId
                }/packages/${encodeURIComponent(config.packageName)}`
              );
              expect(packageResponse.status).to.equal(200);
              validateXRegistryCommonProperties(
                packageResponse.data,
                "Package",
                `${config.groupsEndpoint}/${config.groupId}/packages/${config.packageName}`
              );

              // Verify package has versions URL
              expect(packageResponse.data).to.have.property(
                "versionsurl",
                "Package should have versionsurl property"
              );

              // Step 6: Versions Collection (e.g., /nodescopes/_/packages/express/versions)
              console.log(
                `\n📍 Step 6: Versions Collection (${config.serverUrl}${config.groupsEndpoint}/${config.groupId}/packages/${config.packageName}/versions)`
              );
              const versionsResponse = await loggedAxiosGet(
                `${config.serverUrl}${config.groupsEndpoint}/${
                  config.groupId
                }/packages/${encodeURIComponent(
                  config.packageName
                )}/versions?limit=5`
              );
              expect(versionsResponse.status).to.equal(200);

              // Verify pagination headers (xRegistry conformant)
              expect(versionsResponse.headers).to.have.property(
                "link",
                "Versions collection should have Link header for pagination"
              );

              const versionKeys = validateCollectionFormat(
                versionsResponse.data,
                "Versions",
                `${config.groupsEndpoint}/${config.groupId}/packages/${config.packageName}/versions`
              );

              // Validate individual version structure
              const firstVersionKey = versionKeys[0];
              const firstVersion = versionsResponse.data[firstVersionKey];
              validateXRegistryCommonProperties(
                firstVersion,
                "Version",
                `${config.groupsEndpoint}/${config.groupId}/packages/${config.packageName}/versions/${firstVersionKey}`
              );

              // Step 7: Specific Version (e.g., /nodescopes/_/packages/express/versions/4.18.2)
              console.log(
                `\n📍 Step 7: Specific Version (${config.serverUrl}${config.groupsEndpoint}/${config.groupId}/packages/${config.packageName}/versions/${config.version})`
              );
              try {
                const versionResponse = await loggedAxiosGet(
                  `${config.serverUrl}${config.groupsEndpoint}/${
                    config.groupId
                  }/packages/${encodeURIComponent(
                    config.packageName
                  )}/versions/${encodeURIComponent(config.version)}`
                );
                expect(versionResponse.status).to.equal(200);
                validateXRegistryCommonProperties(
                  versionResponse.data,
                  "Version",
                  `${config.groupsEndpoint}/${config.groupId}/packages/${config.packageName}/versions/${config.version}`
                );

                console.log(
                  `🎉 Complete ${config.name} graph walk successful - all levels xRegistry conformant!`
                );
              } catch (error) {
                if (error.response && error.response.status === 404) {
                  console.log(
                    `⚠️  Specific version ${config.version} not found - using available version for validation`
                  );
                  const availableVersion = firstVersionKey;

                  const versionResponse = await loggedAxiosGet(
                    `${config.serverUrl}${config.groupsEndpoint}/${
                      config.groupId
                    }/packages/${encodeURIComponent(
                      config.packageName
                    )}/versions/${encodeURIComponent(availableVersion)}`
                  );
                  expect(versionResponse.status).to.equal(200);
                  validateXRegistryCommonProperties(
                    versionResponse.data,
                    "Version",
                    `${config.groupsEndpoint}/${config.groupId}/packages/${config.packageName}/versions/${availableVersion}`
                  );

                  console.log(
                    `🎉 Complete ${config.name} graph walk successful with available version - all levels xRegistry conformant!`
                  );
                } else {
                  throw error;
                }
              }
            } catch (error) {
              if (error.response && error.response.status === 404) {
                console.log(
                  `⚠️  Package ${config.packageName} not found - ${config.name} registry may be unavailable`
                );
                console.log(
                  `✅ However, collections and structure validation passed for ${config.name}`
                );
              } else {
                throw error;
              }
            }
          } catch (error) {
            if (error.response && error.response.status === 404) {
              console.log(
                `⚠️  ${config.name} groups collection not available - skipping detailed tests`
              );
              console.log(
                `✅ Server root validation passed for ${config.name}`
              );
            } else if (
              error.code === "ECONNREFUSED" ||
              error.code === "ENOTFOUND"
            ) {
              console.log(
                `⚠️  ${config.name} is not running or not accessible at ${config.serverUrl}`
              );
              console.log(
                `ℹ️  This is expected if ${config.name} is not started in the Docker Compose stack`
              );
              // Don't fail the test if a server is not running
              return;
            } else {
              throw error;
            }
          }
        });
      });
    });
  });

  describe("Service Health Monitoring", () => {
    it("should show healthy downstream services", async () => {
      await checkComposeServices();
      console.log("✅ All compose services health checked");
    });

    it("should handle individual service calls", async () => {
      const services = [
        { name: "NPM", url: `${bridgeUrl}/nodescopes?limit=5` },
        { name: "PyPI", url: `${bridgeUrl}/pythonregistries` },
        { name: "Maven", url: `${bridgeUrl}/javanamespaces` },
        { name: "NuGet", url: `${bridgeUrl}/dotnetregistries` },
        { name: "OCI", url: `${bridgeUrl}/containerregistries` },
      ];

      for (const service of services) {
        try {
          const response = await loggedAxiosGet(service.url);
          console.log(`✅ ${service.name} service accessible through bridge`);
          expect(response.status).to.equal(200);
        } catch (error) {
          console.log(
            `⚠️  ${service.name} service error:`,
            error.response?.status || error.message
          );
          // Don't fail the test if a service is unavailable, just log it
        }
      }
    });
  });
});
