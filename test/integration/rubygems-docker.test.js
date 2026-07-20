const { expect } = require("chai");
const axios = require("axios");
const { promisify } = require("util");
const { exec } = require("child_process");
const path = require("path");

const execPromise = promisify(exec);
const { assertCapabilitiesConform } = require("../helpers/xregistry-capability-conformance.cjs");

describe("RubyGems Docker Integration Tests", function () {
  this.timeout(420000);

  let containerName;
  let serverPort;
  let baseUrl;
  let containerRunning = false;

  const getRandomPort = () =>
    Math.floor(Math.random() * (65535 - 49152) + 49152);

  const executeCommand = async (command, cwd = null) => {
    const options = cwd ? { cwd } : {};
    const { stdout, stderr } = await execPromise(command, options);
    if (stderr && !stderr.includes("WARNING")) {
      console.log(stderr);
    }
    return { stdout, stderr };
  };

  const loggedAxiosGet = async (url) => {
    const response = await axios.get(url, { timeout: 10000 });
    return response;
  };

  const waitForServer = async (url, maxRetries = 30, delay = 2000) => {
    for (let attempt = 0; attempt < maxRetries; attempt += 1) {
      try {
        const response = await axios.get(url, { timeout: 5000 });
        if (response.status === 200) {
          return true;
        }
      } catch {
        // keep retrying
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    return false;
  };

  before(async function () {
    this.timeout(420000);

    containerName = `rubygems-test-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    serverPort = getRandomPort();
    baseUrl = `http://localhost:${serverPort}`;

    const rootPath = path.resolve(__dirname, "../../");

    await executeCommand(
      `docker build -f rubygems.Dockerfile -t rubygems-test-image:latest .`,
      rootPath
    );

    await executeCommand(
      `docker run -d --name ${containerName} -p ${serverPort}:4000 -e PORT=4000 -e HOST=0.0.0.0 rubygems-test-image:latest`
    );

    containerRunning = true;

    const ready = await waitForServer(`${baseUrl}/health`);
    if (!ready) {
      throw new Error("RubyGems server failed to become ready in time");
    }
  });

  after(async function () {
    this.timeout(60000);

    if (containerRunning && containerName) {
      try {
        await executeCommand(`docker stop --time=10 ${containerName}`);
      } catch {
        await executeCommand(`docker kill ${containerName}`).catch(() => {});
      }
      await executeCommand(`docker rm -f ${containerName}`).catch(() => {});
    }

    await executeCommand("docker rmi rubygems-test-image:latest").catch(() => {});
  });

  it("serves the registry root", async () => {
    const response = await loggedAxiosGet(baseUrl);
    expect(response.status).to.equal(200);
    expect(response.data.registryid).to.equal("rubygems-wrapper");
    expect(response.data).to.have.property("rubyregistriesurl");
  });

  it("serves the complete rc2 capability contract", async () => {
    const response = await loggedAxiosGet(`${baseUrl}/capabilities`);
    assertCapabilitiesConform(response.data, {
      flags: ["filter"],
      versionmodes: ["manual", "createdat"],
    });
  });

  it("uses built-in xRegistry resource versions in the model", async () => {
    const response = await loggedAxiosGet(`${baseUrl}/model`);
    const packages = response.data.groups.rubyregistries.resources.packages;
    expect(packages).to.have.property("maxversions", 0);
    expect(packages).to.have.property("versionmode", "createdat");
    expect(packages).not.to.have.property("resources");
    expect(packages).not.to.have.property("versions");
    expect(packages.attributes).to.have.property("versionid");
    expect(packages.metaattributes).to.have.property("defaultversionurl");
    const source = await loggedAxiosGet(`${baseUrl}/modelsource`);
    expect(Object.keys(source.data)).to.deep.equal(["specversion", "registryid", "description", "groups"]);
    expect(source.data).not.to.have.property("default");
    expect(response.data).not.to.have.property("default");
    expect(source.data.groups.rubyregistries.resources.packages).not.to.have.property("resourceattributes");
  });

  it("serves the group collection", async () => {
    const response = await loggedAxiosGet(`${baseUrl}/rubyregistries`);
    expect(response.status).to.equal(200);
    expect(response.data).to.have.property("rubygems.org");
  });

  it("serves the rubygems.org group", async () => {
    const response = await loggedAxiosGet(
      `${baseUrl}/rubyregistries/rubygems.org`
    );
    expect(response.status).to.equal(200);
    expect(response.data).to.have.property("name", "rubygems.org");
    expect(response.data).to.have.property("packagesurl");
  });

  it("serves a bounded package list", async () => {
    const response = await loggedAxiosGet(
      `${baseUrl}/rubyregistries/rubygems.org/packages?limit=5`
    );
    expect(response.status).to.equal(200);
    expect(response.data).to.be.an("object");
    expect(Object.keys(response.data).length).to.be.at.most(5);
  });

  it("serves a specific package", async () => {
    const response = await loggedAxiosGet(
      `${baseUrl}/rubyregistries/rubygems.org/packages/rack`
    );
    expect(response.status).to.equal(200);
    expect(response.data).to.have.property("packageid", "rack");
    expect(response.data).to.have.property("versionsurl");
    expect(response.data).to.have.property("versionscount");
    expect(response.data).to.have.property("metaurl");
    expect(response.data).to.have.property("ancestor");
  });

  it("serves complete package meta consistent with the Resource", async () => {
    const resource = await loggedAxiosGet(`${baseUrl}/rubyregistries/rubygems.org/packages/rack`);
    const meta = await loggedAxiosGet(`${baseUrl}/rubyregistries/rubygems.org/packages/rack/meta`);
    expect(meta.status).to.equal(200);
    expect(meta.data).to.include({ readonly: true, compatibility: "none", defaultversionsticky: false });
    expect(meta.data.defaultversionid).to.equal(resource.data.versionid);
    expect(meta.data).not.to.have.property("ancestor");
    expect(meta.data).to.have.property("defaultversionurl");
  });

  it("serves package versions", async () => {
    const response = await loggedAxiosGet(
      `${baseUrl}/rubyregistries/rubygems.org/packages/rack/versions`
    );
    expect(response.status).to.equal(200);
    expect(response.data).to.be.an("object");
    expect(Object.keys(response.data).length).to.be.greaterThan(0);
    expect(Object.values(response.data).every(version => version.packageid === 'rack')).to.equal(true);
    expect(Object.values(response.data).every(version => typeof version.ancestor === 'string')).to.equal(true);
  });

  it("returns health information", async () => {
    const response = await loggedAxiosGet(`${baseUrl}/health`);
    expect(response.status).to.equal(200);
    expect(response.data.status).to.equal("ok");
  });

  it("uses collision-safe version IDs for platform builds", async () => {
    const response = await loggedAxiosGet(
      `${baseUrl}/rubyregistries/rubygems.org/packages/nokogiri/versions`
    );
    expect(response.status).to.equal(200);

    const versions = Object.entries(response.data);
    const rubyEntry = versions.find(([, value]) => value.platform === "ruby");
    const platformEntry = versions.find(([, value]) => value.platform !== "ruby");

    expect(rubyEntry).to.not.equal(undefined);
    expect(platformEntry).to.not.equal(undefined);

    if (rubyEntry) {
      const [key, value] = rubyEntry;
      expect(key).to.equal(value.number);
    }

    if (platformEntry) {
      const [key, value] = platformEntry;
      const expected = `${value.number}-${value.platform.replace(/\//g, "-").replace(/\s+/g, "-")}`;
      expect(key).to.equal(expected);
    }
  });
});
