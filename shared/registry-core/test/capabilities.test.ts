import assert from "node:assert/strict";
import test from "node:test";
import { createRegistryCapabilities } from "../src";

const EXPECTED_KEYS = [
  "apis",
  "flags",
  "mutable",
  "pagination",
  "schemas",
  "shortself",
  "specversions",
  "sticky",
  "versionmodes",
].sort();

test("builds the complete read-only xRegistry 1.0-rc2 capability map", () => {
  const capabilities = createRegistryCapabilities({
    flags: ["filter", "sort"],
    versionmodes: ["manual", "createdat"],
  });

  assert.deepEqual(Object.keys(capabilities).sort(), EXPECTED_KEYS);
  assert.deepEqual(capabilities, {
    apis: ["/capabilities", "/model", "/modelsource"],
    flags: ["filter", "sort"],
    mutable: [],
    pagination: true,
    schemas: ["xRegistry-json/1.0-rc2"],
    shortself: false,
    specversions: ["1.0-rc2"],
    sticky: false,
    versionmodes: ["manual", "createdat"],
  });
  assert.ok(Array.isArray(capabilities.mutable));
});

test("rejects capability maps that omit mandatory rc2 serialization support", () => {
  assert.throws(
    () => createRegistryCapabilities({ versionmodes: ["createdat"] }),
    /versionmodes must include manual/,
  );
  assert.throws(
    () => createRegistryCapabilities({ schemas: ["JsonSchema/draft-07"] }),
    /schemas must include xRegistry-json\/1.0-rc2/,
  );
  assert.throws(
    () => createRegistryCapabilities({ specversions: ["1.0-rc1"] }),
    /specversions must include 1.0-rc2/,
  );
  assert.throws(
    () => createRegistryCapabilities({ apis: ["model"] }),
    /must start with/,
  );
});
