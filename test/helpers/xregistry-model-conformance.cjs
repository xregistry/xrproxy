"use strict";

const assert = require("node:assert/strict");

const COMMON_FIELDS = new Set([
  "xid", "self", "shortself", "epoch", "name", "description",
  "documentation", "icon", "labels", "createdat", "modifiedat",
]);
const VERSION_FIELDS = new Set([
  ...COMMON_FIELDS, "versionid", "isdefault", "ancestor", "contenttype",
]);
const RESOURCE_FIELDS = new Set([
  ...VERSION_FIELDS, "metaurl", "meta", "versionsurl", "versionscount", "versions",
]);
const META_FIELDS = new Set([
  "xid", "self", "shortself", "xref", "epoch", "createdat", "modifiedat",
  "readonly", "compatibility", "compatibilityauthority", "deprecated",
  "defaultversionid", "defaultversionurl", "defaultversionsticky",
]);

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function definition(value) {
  return typeof value === "string" ? { type: value } : value;
}

function fail(path, message) {
  assert.fail(`${path}: ${message}`);
}

function assertType(value, rawDefinition, path) {
  if (value === undefined || value === null) return;
  const def = definition(rawDefinition);
  assert.ok(def && typeof def.type === "string", `${path}: missing model type`);
  const type = def.type;

  switch (type) {
    case "any":
      return;
    case "boolean":
      assert.equal(typeof value, "boolean", `${path}: expected boolean`);
      break;
    case "string":
    case "uri":
    case "url":
    case "uri-reference":
    case "url-reference":
    case "uritemplate":
    case "binary":
      assert.equal(typeof value, "string", `${path}: expected ${type}`);
      break;
    case "xid":
      assert.equal(typeof value, "string", `${path}: expected xid string`);
      assert.ok(value.startsWith("/"), `${path}: xid must start with /`);
      break;
    case "timestamp":
      assert.equal(typeof value, "string", `${path}: expected timestamp string`);
      assert.ok(!Number.isNaN(Date.parse(value)), `${path}: invalid RFC3339 timestamp`);
      assert.match(value, /Z$/, `${path}: server timestamp must be normalized to UTC`);
      break;
    case "integer":
      assert.ok(Number.isInteger(value), `${path}: expected integer`);
      break;
    case "uinteger":
      assert.ok(Number.isInteger(value) && value >= 0, `${path}: expected unsigned integer`);
      break;
    case "decimal":
      assert.ok(typeof value === "number" && Number.isFinite(value), `${path}: expected decimal`);
      break;
    case "array":
      assert.ok(Array.isArray(value), `${path}: expected array`);
      assert.ok(def.item, `${path}: array model is missing item`);
      value.forEach((item, index) => {
        if (item === null) fail(`${path}[${index}]`, "array items cannot be null");
        assertType(item, def.item, `${path}[${index}]`);
      });
      break;
    case "map":
      assert.ok(plainObject(value), `${path}: expected map`);
      assert.ok(def.item, `${path}: map model is missing item`);
      for (const [key, item] of Object.entries(value)) {
        assert.match(key, /^[a-z0-9][a-z0-9_:.-]{0,62}$/, `${path}: invalid map key ${key}`);
        if (item === null) fail(`${path}.${key}`, "map values cannot be null");
        assertType(item, def.item, `${path}.${key}`);
      }
      break;
    case "object":
      assert.ok(plainObject(value), `${path}: expected object`);
      assertObjectAttributes(value, def.attributes ?? {}, path, def.namecharset ?? "strict");
      break;
    default:
      fail(path, `unsupported model type ${type}`);
  }

  if (Array.isArray(def.enum) && def.enum.length > 0 && def.strict !== false) {
    assert.ok(def.enum.some((candidate) => Object.is(candidate, value)), `${path}: value is outside strict enum`);
  }
}

function assertObjectAttributes(value, definitions, path, namecharset = "strict") {
  const wildcard = definitions["*"];
  const namePattern = namecharset === "extended"
    ? /^[a-z0-9][a-z0-9_:.-]{0,62}$/
    : /^[a-z][a-z0-9_]{0,62}$/;
  for (const [name, child] of Object.entries(value)) {
    if (child === undefined) continue;
    assert.match(name, namePattern, `${path}: invalid object attribute name ${name}`);
    const childDefinition = definitions[name] ?? wildcard;
    if (!childDefinition) fail(`${path}.${name}`, "attribute is not permitted by the model");
    assertType(child, childDefinition, `${path}.${name}`);
  }
  for (const [name, rawDefinition] of Object.entries(definitions)) {
    if (name === "*") continue;
    const def = definition(rawDefinition);
    if (def.required === true) {
      assert.ok(value[name] !== undefined && value[name] !== null, `${path}.${name}: required attribute is absent`);
    }
  }
}

function modelParts(model, groupType, resourceType) {
  const group = model.groups?.[groupType];
  assert.ok(group, `model group ${groupType} is missing`);
  if (!resourceType) return { group };
  const resource = group.resources?.[resourceType];
  assert.ok(resource, `model resource ${groupType}/${resourceType} is missing`);
  return { group, resource };
}

function assertTopLevel(entity, definitions, allowed, dynamic, path) {
  assert.ok(plainObject(entity), `${path}: expected entity object`);
  const wildcard = definitions["*"];
  for (const [name, value] of Object.entries(entity)) {
    if (value === undefined) continue;
    const def = definitions[name] ?? wildcard;
    if (def) {
      assertType(value, def, `${path}.${name}`);
      continue;
    }
    if (allowed.has(name) || dynamic.has(name)) continue;
    fail(`${path}.${name}`, "attribute is not permitted by the model or xRegistry Core");
  }
}

function assertPresent(entity, fields, path) {
  for (const field of fields) {
    assert.ok(entity[field] !== undefined && entity[field] !== null, `${path}.${field}: required core attribute is absent`);
  }
}

function assertGroupConforms(model, groupType, entity, path = groupType) {
  const { group } = modelParts(model, groupType);
  const id = `${group.singular}id`;
  const dynamic = new Set([id]);
  for (const resource of Object.values(group.resources ?? {})) {
    dynamic.add(`${resource.plural}url`);
    dynamic.add(`${resource.plural}count`);
    dynamic.add(resource.plural);
  }
  assertTopLevel(entity, group.attributes ?? {}, COMMON_FIELDS, dynamic, path);
  assertPresent(entity, [id, "self", "xid", "epoch", "createdat", "modifiedat"], path);
}

function assertVersionConforms(model, groupType, resourceType, entity, path = `${groupType}/${resourceType}/versions`) {
  const { resource } = modelParts(model, groupType, resourceType);
  const id = `${resource.singular}id`;
  const dynamic = new Set([id]);
  if (resource.hasdocument !== false) {
    dynamic.add(`${resource.singular}url`);
    dynamic.add(resource.singular);
    dynamic.add(`${resource.singular}base64`);
  }
  assertTopLevel(entity, resource.attributes ?? {}, VERSION_FIELDS, dynamic, path);
  assertPresent(entity, [id, "versionid", "self", "xid", "epoch", "isdefault", "createdat", "modifiedat", "ancestor"], path);
}

function assertMetaConforms(model, groupType, resourceType, entity, path = `${groupType}/${resourceType}/meta`) {
  const { resource } = modelParts(model, groupType, resourceType);
  const id = `${resource.singular}id`;
  const dynamic = new Set([id]);
  assertTopLevel(entity, resource.metaattributes ?? {}, META_FIELDS, dynamic, path);
  assertPresent(entity, [
    id, "self", "xid", "epoch", "createdat", "modifiedat", "readonly",
    "compatibility", "defaultversionid", "defaultversionurl", "defaultversionsticky",
  ], path);
  assert.equal(Object.hasOwn(entity, "ancestor"), false, `${path}.ancestor: Version ancestry is not Meta`);
}

function assertResourceProjectsVersion(model, groupType, resourceType, resourceEntity, versionEntity, path = `${groupType}/${resourceType}`) {
  const { resource } = modelParts(model, groupType, resourceType);
  assertVersionConforms(model, groupType, resourceType, versionEntity, `${path}.selected-version`);
  assert.equal(versionEntity.isdefault, true, `${path}: selected Version must be the default`);
  assert.equal(resourceEntity.versionid, versionEntity.versionid, `${path}.versionid: Resource selected a different Version`);
  const projected = new Set([...VERSION_FIELDS, ...Object.keys(resource.attributes ?? {}), `${resource.singular}id`]);
  for (const name of projected) {
    if (["self", "shortself", "xid"].includes(name)) continue;
    if (versionEntity[name] === undefined && resourceEntity[name] === undefined) continue;
    assert.deepEqual(resourceEntity[name], versionEntity[name], `${path}.${name}: Resource must project the selected default Version`);
  }
}

function assertResourceConforms(model, groupType, resourceType, entity, path = `${groupType}/${resourceType}`) {
  const { resource } = modelParts(model, groupType, resourceType);
  const id = `${resource.singular}id`;
  const definitions = { ...(resource.attributes ?? {}), ...(resource.resourceattributes ?? {}) };
  const dynamic = new Set([id]);
  if (resource.hasdocument !== false) {
    dynamic.add(`${resource.singular}url`);
    dynamic.add(resource.singular);
    dynamic.add(`${resource.singular}base64`);
  }
  assertTopLevel(entity, definitions, RESOURCE_FIELDS, dynamic, path);
  assertPresent(entity, [
    id, "versionid", "self", "xid", "epoch", "isdefault", "createdat", "modifiedat",
    "ancestor", "metaurl", "versionsurl", "versionscount",
  ], path);
  assert.equal(Object.hasOwn(entity, "defaultversionurl"), false, `${path}.defaultversionurl: Resource-specific default metadata belongs in Meta`);
  if (plainObject(entity.versions)) {
    for (const [versionId, version] of Object.entries(entity.versions)) {
      assertVersionConforms(model, groupType, resourceType, version, `${path}.versions.${versionId}`);
    }
    const selected = entity.versions[entity.versionid];
    if (selected) assertResourceProjectsVersion(model, groupType, resourceType, entity, selected, path);
  }
  if (plainObject(entity.meta)) {
    assertMetaConforms(model, groupType, resourceType, entity.meta, `${path}.meta`);
  }
}

module.exports = {
  assertGroupConforms,
  assertMetaConforms,
  assertResourceConforms,
  assertResourceProjectsVersion,
  assertType,
  assertVersionConforms,
};
