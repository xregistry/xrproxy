"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const Ajv = require("ajv");
const addFormats = require("ajv-formats");
const root = path.resolve(__dirname, "../..");
const { expandRegistryModel } = require(path.join(root, "shared", "registry-core", "dist", "src"));
const proxyModels = [
  "npm",
  "pypi",
  "maven",
  "nuget",
  "oci",
  "mcp",
  "crates",
  "terraform",
  "rubygems",
  "packagist",
  "pubdev",
  "huggingface",
  "gomod",
];
const schemaPath = path.join(root, "test", "fixtures", "xregistry-model-v1.0-rc2.schema.json");
const expectedSchemaSha256 = "fe1f00a4dfc7ce3b11b95a0ad890a88acb2ad3794fc5263ff0fec1aa6d4ac60a";
// Official source, pinned by tag and commit:
// https://github.com/xregistry/spec/blob/dbcbeac1dce9a0653ea39ea504f52edde2dc00a2/core/model.schema.json

function loadModel(service) {
  return JSON.parse(fs.readFileSync(path.join(root, service, "model.json"), "utf8"));
}

function resourcesOf(model) {
  return Object.values(model.groups ?? {}).flatMap(group => Object.values(group.resources ?? {}));
}

describe("proxy xRegistry extension model contracts", () => {
  const schemaText = fs.readFileSync(schemaPath, "utf8").replace(/\r\n/g, "\n");
  const actualHash = crypto.createHash("sha256").update(schemaText).digest("hex");
  assert.equal(actualHash, expectedSchemaSha256, "the vendored schema must remain the official v1.0-rc2 schema");

  const ajv = new Ajv({ allErrors: true, strict: false });
  const draft7 = require("ajv/dist/refs/json-schema-draft-07.json");
  ajv.addMetaSchema(draft7, "https://json-schema.org/draft-07/schema#");
  addFormats(ajv);
  const validate = ajv.compile(JSON.parse(schemaText));

  for (const service of proxyModels) {
    it(`${service} validates against the official xRegistry 1.0-rc2 model schema`, () => {
      const valid = validate(loadModel(service));
      assert.equal(valid, true, ajv.errorsText(validate.errors, { separator: "\n" }));
    });

    it(`${service} expands its model source into the required rc2 runtime scopes`, () => {
      const source = loadModel(service);
      const full = expandRegistryModel(source);
      assert.notDeepEqual(full, source);
      assert.equal(validate(full), true, ajv.errorsText(validate.errors, { separator: "\n" }));
      for (const name of ['specversion', 'registryid', 'model', 'modelsource']) {
        assert.ok(full.attributes[name], `${service}: missing Registry attribute ${name}`);
      }
      for (const [groupName, group] of Object.entries(full.groups ?? {})) {
        assert.ok(group.attributes[`${group.singular}id`], `${service}.${groupName}: missing Group ID`);
        for (const [resourceName, resource] of Object.entries(group.resources ?? {})) {
          for (const name of [`${resource.singular}id`, 'versionid', 'isdefault', 'ancestor']) {
            assert.ok(resource.attributes[name], `${service}.${groupName}.${resourceName}: missing Version ${name}`);
          }
          for (const name of ['metaurl', 'versionsurl', 'versionscount']) {
            assert.ok(resource.resourceattributes[name], `${service}.${groupName}.${resourceName}: missing Resource ${name}`);
          }
          for (const name of ['readonly', 'defaultversionid', 'defaultversionurl', 'defaultversionsticky']) {
            assert.ok(resource.metaattributes[name], `${service}.${groupName}.${resourceName}: missing Meta ${name}`);
          }
        }
      }
    });

    it(`${service} does not model Versions as nested resources`, () => {
      for (const resource of resourcesOf(loadModel(service))) {
        assert.equal(Object.hasOwn(resource, "versions"), false, "unsupported resource.versions model");
        assert.equal(Object.hasOwn(resource, "resources"), false, "resources cannot be nested beneath a Resource");
      }
    });

  }

  for (const service of proxyModels) {
    it(`${service} declares a valid Resource version policy`, () => {
      for (const resource of resourcesOf(loadModel(service))) {
        assert.equal(resource.hasdocument, false);
        if (resource.maxversions !== undefined) assert.equal(resource.maxversions, 0);
        if (resource.setversionid !== undefined) assert.equal(resource.setversionid, true);
        if (resource.versionmode !== undefined) {
          assert.ok(["createdat", "semver", "manual"].includes(resource.versionmode));
        }
      }
    });
  }

  it("Packagist extension attributes use the formal Composer names", () => {
    const attributes = loadModel("packagist").groups.composerregistries.resources.packages.attributes;
    for (const name of ["versionnormalized", "require-dev", "sourcereference"]) {
      assert.ok(Object.hasOwn(attributes, name), `missing ${name}`);
    }
    assert.ok(Object.hasOwn(loadModel("packagist").groups.composerregistries.resources.packages.metaattributes, "currentversion"));
    for (const name of ["versionNormalized", "requiredev", "requireDev", "sourceReference", "currentVersion"]) {
      assert.equal(Object.hasOwn(attributes, name), false, `obsolete ${name}`);
    }
  });

  it("mixed and structured upstream values have conforming model definitions", () => {
    const huggingface = loadModel("huggingface").groups.huggingfaceregistries.resources;
    for (const resource of Object.values(huggingface)) {
      assert.equal(resource.metaattributes.gated.type, "any");
      assert.equal(resource.metaattributes.refs.type, "object");
      assert.ok(resource.metaattributes.refs.attributes.branches);
    }

    const terraform = loadModel("terraform").groups.terraformregistries.resources;
    for (const name of ["protocols", "platforms"]) {
      assert.ok(terraform.providers.attributes[name], `missing Terraform provider attribute ${name}`);
    }
    assert.equal(terraform.providers.attributes.published_at.type, "timestamp");
  });

  it("pub.dev uses manual mode for opaque build-metadata IDs", () => {
    const packages = loadModel("pubdev").groups.dartregistries.resources.packages;
    assert.equal(packages.versionmode, "manual");
  });

  it("pub.dev xid targets use plural collection type names", () => {
    const attributes = loadModel("pubdev").groups.dartregistries.resources.packages.attributes;
    assert.equal(attributes.package.target, "/dartregistries/packages");
    assert.equal(attributes.dependencies.item.attributes.package.target, "/dartregistries/packages");
    assert.equal(attributes.dev_dependencies.item.attributes.package.target, "/dartregistries/packages");
  });
});
