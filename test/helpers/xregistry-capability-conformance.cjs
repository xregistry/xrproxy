"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const Ajv = require("ajv");

const schema = require(path.join(__dirname, "../fixtures/xregistry-capabilities-v1.0-rc2.schema.json"));
const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(schema);

const DEFAULT_APIS = ["/capabilities", "/model", "/modelsource"];

function assertCapabilitiesConform(actual, expected) {
  const valid = validate(actual);
  assert.equal(valid, true, ajv.errorsText(validate.errors, { separator: "\n" }));
  assert.deepEqual(Object.keys(actual).sort(), [...schema.required].sort());
  const normalized = JSON.parse(JSON.stringify(actual));
  assert.deepEqual(normalized, {
    apis: expected.apis ?? DEFAULT_APIS,
    flags: expected.flags,
    mutable: [],
    pagination: true,
    schemas: ["xRegistry-json/1.0-rc2"],
    shortself: false,
    specversions: ["1.0-rc2"],
    sticky: false,
    versionmodes: expected.versionmodes,
  });
  assert.ok(Array.isArray(actual.mutable), "mutable must be an array");
  assert.equal(Object.hasOwn(actual, "formats"), false, "legacy formats capability is forbidden");
  assert.equal(Object.hasOwn(actual, "filter"), false, "legacy filter boolean is forbidden");
  assert.equal(Object.hasOwn(actual, "sort"), false, "legacy sort boolean is forbidden");
}

module.exports = { assertCapabilitiesConform };
