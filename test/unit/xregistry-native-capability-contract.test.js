"use strict";

const path = require("node:path");
const root = path.resolve(__dirname, "../..");
const { createRegistryCapabilities } = require(path.join(root, "shared", "registry-core", "dist", "src"));
const { assertCapabilitiesConform } = require(path.join(root, "test", "helpers", "xregistry-capability-conformance.cjs"));

const profiles = {
  huggingface: { flags: ["filter"], versionmodes: ["manual"] },
  packagist: { flags: ["filter", "sort"], versionmodes: ["manual", "createdat"] },
  pubdev: { flags: ["filter", "sort"], versionmodes: ["manual"] },
  rubygems: { flags: ["filter"], versionmodes: ["manual", "createdat"] },
  terraform: { flags: [], versionmodes: ["manual", "semver"] },
};

describe("native proxy xRegistry 1.0-rc2 capability contracts", () => {
  for (const [service, profile] of Object.entries(profiles)) {
    it(service + " has a schema-valid complete capability map", () => {
      const capabilities = createRegistryCapabilities(profile);
      assertCapabilitiesConform(capabilities, profile);
    });
  }
});
