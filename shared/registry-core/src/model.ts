export type RegistryModel = Readonly<Record<string, unknown>>;

type JsonObject = Record<string, unknown>;
type AttributeMap = Record<string, JsonObject>;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function object(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function attribute(name: string, definition: JsonObject): JsonObject {
  return { name, ...definition };
}

function anyObject(): JsonObject {
  return { type: 'object', attributes: { '*': { type: 'any' } } };
}

function entityId(name: string): JsonObject {
  return attribute(name, { type: 'string', immutable: true, required: true });
}

const COMMON_ENTITY_ATTRIBUTES: AttributeMap = {
  self: attribute('self', { type: 'url', immutable: true, readonly: true, required: true }),
  shortself: attribute('shortself', { type: 'url', immutable: true, readonly: true }),
  xid: attribute('xid', { type: 'xid', readonly: true, immutable: true, required: true }),
  epoch: attribute('epoch', { type: 'uinteger', readonly: true, required: true }),
  name: attribute('name', { type: 'string' }),
  description: attribute('description', { type: 'string' }),
  documentation: attribute('documentation', { type: 'url' }),
  icon: attribute('icon', { type: 'url' }),
  labels: attribute('labels', { type: 'map', item: { type: 'string' } }),
  createdat: attribute('createdat', { type: 'timestamp', required: true }),
  modifiedat: attribute('modifiedat', { type: 'timestamp', required: true }),
};

const REGISTRY_ATTRIBUTES: AttributeMap = {
  specversion: attribute('specversion', {
    type: 'string', readonly: true, required: true, default: '1.0-rc2',
  }),
  registryid: attribute('registryid', {
    type: 'string', immutable: true, readonly: true, required: true,
  }),
  ...COMMON_ENTITY_ATTRIBUTES,
  capabilities: attribute('capabilities', anyObject()),
  model: attribute('model', { ...anyObject(), readonly: true }),
  modelsource: attribute('modelsource', anyObject()),
};

const VERSION_ATTRIBUTES: AttributeMap = {
  versionid: attribute('versionid', { type: 'string', immutable: true, required: true }),
  self: attribute('self', { type: 'url', immutable: true, readonly: true, required: true }),
  shortself: attribute('shortself', { type: 'url', immutable: true, readonly: true, required: true }),
  xid: attribute('xid', { type: 'xid', readonly: true, immutable: true, required: true }),
  epoch: attribute('epoch', { type: 'uinteger', readonly: true, required: true }),
  name: attribute('name', { type: 'string' }),
  isdefault: attribute('isdefault', {
    type: 'boolean', readonly: true, required: true, default: false,
  }),
  description: attribute('description', { type: 'string' }),
  documentation: attribute('documentation', { type: 'url' }),
  icon: attribute('icon', { type: 'url' }),
  labels: attribute('labels', { type: 'map', item: { type: 'string' } }),
  createdat: attribute('createdat', { type: 'timestamp', required: true }),
  modifiedat: attribute('modifiedat', { type: 'timestamp', required: true }),
  ancestor: attribute('ancestor', { type: 'string', required: true }),
  contenttype: attribute('contenttype', { type: 'string' }),
};

const META_ATTRIBUTES: AttributeMap = {
  self: attribute('self', { type: 'url', immutable: true, readonly: true, required: true }),
  shortself: attribute('shortself', { type: 'url', immutable: true, readonly: true }),
  xid: attribute('xid', { type: 'xid', readonly: true, immutable: true, required: true }),
  xref: attribute('xref', { type: 'url' }),
  epoch: attribute('epoch', { type: 'uinteger', readonly: true, required: true }),
  createdat: attribute('createdat', { type: 'timestamp', required: true }),
  modifiedat: attribute('modifiedat', { type: 'timestamp', required: true }),
  readonly: attribute('readonly', {
    type: 'boolean', readonly: true, required: true, default: false,
  }),
  compatibility: attribute('compatibility', {
    type: 'string',
    enum: ['none', 'backward', 'backward_transitive', 'forward', 'forward_transitive', 'full', 'full_transitive'],
    required: true,
    default: 'none',
  }),
  compatibilityauthority: attribute('compatibilityauthority', {
    type: 'string', enum: ['external', 'server'],
  }),
  deprecated: attribute('deprecated', {
    type: 'object',
    attributes: {
      effective: attribute('effective', { type: 'timestamp' }),
      removal: attribute('removal', { type: 'timestamp' }),
      alternative: attribute('alternative', { type: 'url' }),
      documentation: attribute('documentation', { type: 'url' }),
      '*': attribute('*', { type: 'any' }),
    },
  }),
  defaultversionid: attribute('defaultversionid', { type: 'string', required: true }),
  defaultversionurl: attribute('defaultversionurl', {
    type: 'url', readonly: true, required: true,
  }),
  defaultversionsticky: attribute('defaultversionsticky', {
    type: 'boolean', required: true, default: false,
  }),
};

function normalizeDefinition(name: string, raw: unknown): JsonObject {
  const definition = typeof raw === 'string' ? { type: raw } : clone(object(raw));
  const nested = object(definition['attributes']);
  if (Object.keys(nested).length > 0) definition['attributes'] = normalizeAttributes(nested);
  const item = object(definition['item']);
  if (Object.keys(item).length > 0) {
    const normalizedItem = clone(item);
    const itemAttributes = object(normalizedItem['attributes']);
    if (Object.keys(itemAttributes).length > 0) normalizedItem['attributes'] = normalizeAttributes(itemAttributes);
    definition['item'] = normalizedItem;
  }
  return { name, ...definition };
}

function normalizeAttributes(raw: JsonObject): AttributeMap {
  return Object.fromEntries(
    Object.entries(raw).map(([name, definition]) => [name, normalizeDefinition(name, definition)]),
  );
}

function mergeAttributes(builtIns: AttributeMap, source: unknown): AttributeMap {
  const extensions = normalizeAttributes(object(source));
  const result: AttributeMap = clone(builtIns);
  for (const [name, extension] of Object.entries(extensions)) {
    result[name] = { ...(result[name] ?? {}), ...extension };
  }
  return result;
}

function collectionAttributes(plural: string): AttributeMap {
  return {
    [`${plural}url`]: attribute(`${plural}url`, {
      type: 'url', immutable: true, readonly: true, required: true,
    }),
    [`${plural}count`]: attribute(`${plural}count`, {
      type: 'uinteger', readonly: true, required: true,
    }),
    [plural]: attribute(plural, {
      type: 'map', item: { type: 'object', attributes: { '*': { type: 'any' } } },
    }),
  };
}

function expandResource(resourceName: string, rawResource: unknown): JsonObject {
  const source = clone(object(rawResource));
  const singular = typeof source['singular'] === 'string' ? source['singular'] : resourceName;
  const plural = typeof source['plural'] === 'string' ? source['plural'] : resourceName;
  const idName = `${singular}id`;
  const hasDocument = source['hasdocument'] !== false;

  const versionBuiltIns: AttributeMap = {
    [idName]: entityId(idName),
    ...VERSION_ATTRIBUTES,
  };
  if (hasDocument) {
    versionBuiltIns[`${singular}url`] = attribute(`${singular}url`, { type: 'url' });
    versionBuiltIns[singular] = attribute(singular, { type: 'any' });
    versionBuiltIns[`${singular}base64`] = attribute(`${singular}base64`, { type: 'string' });
  }

  const resourceBuiltIns: AttributeMap = {
    [idName]: entityId(idName),
    self: attribute('self', { type: 'url', immutable: true, readonly: true, required: true }),
    shortself: attribute('shortself', { type: 'url', immutable: true, readonly: true }),
    xid: attribute('xid', { type: 'xid', readonly: true, immutable: true, required: true }),
    metaurl: attribute('metaurl', { type: 'url', readonly: true, immutable: true, required: true }),
    meta: attribute('meta', { type: 'object', attributes: { '*': attribute('*', { type: 'any' }) } }),
    versionsurl: attribute('versionsurl', { type: 'url', immutable: true, readonly: true, required: true }),
    versionscount: attribute('versionscount', { type: 'uinteger', readonly: true, required: true }),
    versions: attribute('versions', {
      type: 'map', item: { type: 'object', attributes: { '*': { type: 'any' } } },
    }),
  };
  const metaBuiltIns: AttributeMap = { [idName]: entityId(idName), ...META_ATTRIBUTES };

  return {
    ...source,
    ...(source['plural'] === undefined ? {} : { plural }),
    singular,
    attributes: mergeAttributes(versionBuiltIns, source['attributes']),
    resourceattributes: mergeAttributes(resourceBuiltIns, source['resourceattributes']),
    metaattributes: mergeAttributes(metaBuiltIns, source['metaattributes']),
  };
}

function expandGroup(groupName: string, rawGroup: unknown): JsonObject {
  const source = clone(object(rawGroup));
  const singular = typeof source['singular'] === 'string' ? source['singular'] : groupName;
  const plural = typeof source['plural'] === 'string' ? source['plural'] : groupName;
  const resourcesSource = object(source['resources']);
  const resources = Object.fromEntries(
    Object.entries(resourcesSource).map(([name, resource]) => [name, expandResource(name, resource)]),
  );
  const builtIns: AttributeMap = {
    [`${singular}id`]: entityId(`${singular}id`),
    ...COMMON_ENTITY_ATTRIBUTES,
  };
  for (const [name, rawResource] of Object.entries(resourcesSource)) {
    const resource = object(rawResource);
    const resourcePlural = typeof resource['plural'] === 'string' ? resource['plural'] : name;
    Object.assign(builtIns, collectionAttributes(resourcePlural));
  }
  return {
    ...source,
    ...(source['plural'] === undefined ? {} : { plural }),
    singular,
    attributes: mergeAttributes(builtIns, source['attributes']),
    ...(Object.keys(resources).length > 0 ? { resources } : {}),
  };
}

/**
 * Expand an xRegistry 1.0-rc2 model source into the full runtime model.
 *
 * Core specification-defined Registry, Group, Version, Resource and Meta
 * attributes are added without mutating the source. Explicit source
 * definitions override the corresponding built-in aspects.
 */
export function expandRegistryModel(modelSource: RegistryModel): JsonObject {
  const source = clone(object(modelSource));
  const groupsSource = object(source['groups']);
  const groups = Object.fromEntries(
    Object.entries(groupsSource).map(([name, group]) => [name, expandGroup(name, group)]),
  );
  const registryBuiltIns: AttributeMap = clone(REGISTRY_ATTRIBUTES);
  for (const [name, rawGroup] of Object.entries(groupsSource)) {
    const group = object(rawGroup);
    const plural = typeof group['plural'] === 'string' ? group['plural'] : name;
    Object.assign(registryBuiltIns, collectionAttributes(plural));
  }
  return {
    ...source,
    attributes: mergeAttributes(registryBuiltIns, source['attributes']),
    ...(Object.keys(groups).length > 0 ? { groups } : {}),
  };
}

/** Return an isolated copy suitable for the /modelsource response. */
export function cloneModelSource(modelSource: RegistryModel): JsonObject {
  return clone(object(modelSource));
}
