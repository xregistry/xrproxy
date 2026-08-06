import type { Express, NextFunction, Request, Response } from 'express';
import type { HfConfig } from '../config';
import {
  defaultBranchOf,
  MAX_DETAIL_FILTER_HYDRATIONS,
  MAX_DISCOVERY_ITEMS,
  MAX_FILTERED_SKIP,
  PrefixSearchLimitError,
  type HfCommit,
  type HfRef,
  type HfRepoInfo,
  type HfSibling,
  type HfSpaceRuntime,
  type HuggingFaceClient,
  type NamespaceDiscovery,
  type NamespaceRecord,
  type ResourceType,
} from '../hf-client';
import {
  decodeLegacyRepoId,
  identityToRepoId,
  isHashedEntityId,
  isValidRepoPart,
  LEGACY_HF_GROUP_ID,
  projectGroupIds,
  projectResourceIds,
  repoIdToIdentity,
  UNNAMESPACED_GROUP_ID,
} from '../repo-utils';

const SPEC_VERSION = '1.0-rc2';
const REGISTRY_ID = 'huggingface-hub';
const REGISTRY_NAME = 'Hugging Face Hub xRegistry';
const GROUP_TYPE = 'huggingfaceregistries';
const GROUP_SINGULAR = 'huggingfaceregistry';
const RESOURCE_TYPES: readonly ResourceType[] = ['models', 'datasets', 'spaces'];
const RESOURCE_SINGULARS: Record<ResourceType, string> = {
  models: 'model', datasets: 'dataset', spaces: 'space',
};
const STARTUP_TIME = new Date().toISOString();

interface GroupProjection {
  readonly canonicalGroupId: string;
  readonly projectedGroupId: string;
  readonly namespace: NamespaceRecord;
  readonly completeTypes: Readonly<Record<ResourceType, boolean>>;
}

interface ResourceProjection {
  readonly canonicalRepoId: string;
  readonly canonicalResourceId: string;
  readonly projectedResourceId: string;
}

interface ExactResource {
  readonly canonicalIdentity: ReturnType<typeof repoIdToIdentity>;
  readonly projectedGroupId: string;
  readonly projectedResourceId: string;
  readonly entity: Record<string, unknown>;
  readonly info: CanonicalRepoInfo;
  readonly refs: Awaited<ReturnType<HuggingFaceClient['getRefs']>>;
  readonly versionscount: number;
}

function problem(status: number, title: string, detail?: string, instance?: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'about:blank', title, status, ...(detail ? { detail } : {}), ...(instance ? { instance } : {}), ...extra };
}

function getBaseUrl(req: Request): string {
  const xBase = req.get('x-base-url');
  if (xBase) return xBase;
  if (process.env['BASE_URL']) return process.env['BASE_URL'];
  const proto = req.get('x-forwarded-proto') ?? req.protocol ?? 'http';
  const host = req.get('x-forwarded-host') ?? req.get('host');
  return host ? `${proto}://${host}` : `${proto}://localhost`;
}

function setCacheMutable(res: Response, ttlSec = 300): void {
  res.setHeader('Cache-Control', `public, max-age=${ttlSec}, s-maxage=${ttlSec}, stale-while-revalidate=60`);
}
function setCacheImmutable(res: Response): void {
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
}
function rp(req: Request, name: string): string {
  const value = req.params[name];
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}
function resourcePath(type: ResourceType, groupId: string, resourceId: string): string {
  return `/${GROUP_TYPE}/${groupId}/${type}/${resourceId}`;
}
function resourceUrl(base: string, type: ResourceType, groupId: string, resourceId: string): string {
  return `${base}/${GROUP_TYPE}/${encodeURIComponent(groupId)}/${type}/${encodeURIComponent(resourceId)}`;
}
function versionPath(type: ResourceType, groupId: string, resourceId: string, sha: string): string {
  return `${resourcePath(type, groupId, resourceId)}/versions/${sha}`;
}

function parseLimit(req: Request): number {
  return Math.min(Math.max(Number.parseInt(String(req.query['limit'] ?? '20'), 10) || 20, 1), 100);
}
function parseOffset(req: Request): number {
  return Math.max(Number.parseInt(String(req.query['offset'] ?? req.query['skip'] ?? '0'), 10) || 0, 0);
}
function buildPageUrl(req: Request, offset: number, limit: number): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(req.query)) {
    if (typeof value === 'string') query.set(key, value);
  }
  query.delete('skip');
  query.set('offset', String(offset));
  query.set('limit', String(limit));
  return `${getBaseUrl(req)}${req.path}?${query}`;
}
function setPagination(
  req: Request,
  res: Response,
  offset: number,
  limit: number,
  page: { totalCount?: number; hasMore: boolean },
): void {
  if (page.totalCount !== undefined) res.setHeader('X-Total-Count', String(page.totalCount));
  const links: string[] = [];
  if (offset > 0) {
    links.push(`<${buildPageUrl(req, 0, limit)}>; rel="first"`);
    links.push(`<${buildPageUrl(req, Math.max(0, offset - limit), limit)}>; rel="prev"`);
  }
  if (page.hasMore) links.push(`<${buildPageUrl(req, offset + limit, limit)}>; rel="next"`);
  if (page.totalCount !== undefined && offset + limit < page.totalCount) {
    const last = Math.floor((Math.max(page.totalCount, 1) - 1) / limit) * limit;
    links.push(`<${buildPageUrl(req, last, limit)}>; rel="last"`);
  }
  if (links.length) res.setHeader('Link', links.join(', '));
}

interface EntityFilter {
  readonly attribute: string;
  readonly pattern: string;
}

function entityFilter(value: unknown, attributes: readonly string[]): EntityFilter | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return null;
  const match = /^([a-z][a-z0-9_]*)=(.+)$/i.exec(value);
  if (!match || !attributes.includes(match[1]!.toLowerCase())) return null;
  return { attribute: match[1]!.toLowerCase(), pattern: match[2]! };
}
function wildcard(value: string, pattern: string): boolean {
  const source = pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${source}$`, 'i').test(value);
}
function matchesEntityFilter(entity: Record<string, unknown>, filter: EntityFilter | undefined): boolean {
  if (!filter) return true;
  const value = entity[filter.attribute];
  return value !== undefined && value !== null && wildcard(String(value), filter.pattern);
}

function rejectUnsupportedSort(req: Request, res: Response): boolean {
  if (req.query['sort'] === undefined) return false;
  res.status(400).json(problem(
    400,
    'Unsupported sort',
    'Hugging Face collections do not support the xRegistry sort flag.',
    req.originalUrl,
  ));
  return true;
}

function buildGroupProjections(discovery: NamespaceDiscovery): readonly GroupProjection[] {
  const projectedIds = projectGroupIds(discovery.namespaces.map(namespace => namespace.id));
  return discovery.namespaces.map(namespace => ({
    canonicalGroupId: namespace.id,
    projectedGroupId: projectedIds.get(namespace.id) ?? namespace.id,
    namespace,
    completeTypes: discovery.completeTypes,
  }));
}

function buildGroupDoc(
  base: string,
  group: GroupProjection,
): Record<string, unknown> {
  const groupPath = `/${GROUP_TYPE}/${group.projectedGroupId}`;
  const self = `${base}/${GROUP_TYPE}/${encodeURIComponent(group.projectedGroupId)}`;
  const counts: Record<string, number> = {};
  for (const type of RESOURCE_TYPES) {
    if (group.completeTypes[type]) counts[`${type}count`] = group.namespace.counts[type] ?? 0;
  }
  return {
    [`${GROUP_SINGULAR}id`]: group.projectedGroupId,
    xid: groupPath,
    self,
    name: group.canonicalGroupId === UNNAMESPACED_GROUP_ID ? 'Unnamespaced repositories' : group.canonicalGroupId,
    namespace: group.canonicalGroupId === UNNAMESPACED_GROUP_ID ? '' : group.canonicalGroupId,
    epoch: 1,
    createdat: STARTUP_TIME,
    modifiedat: STARTUP_TIME,
    ...Object.fromEntries(RESOURCE_TYPES.map(type => [`${type}url`, `${self}/${type}`])),
    ...counts,
  };
}

function normalizeSibling(sibling: HfSibling): Record<string, unknown> {
  return {
    rfilename: sibling.rfilename,
    ...(sibling.size === undefined ? {} : { size: sibling.size }),
    ...(sibling.blobId === undefined ? {} : { blobid: sibling.blobId }),
    ...(sibling.lfs === undefined ? {} : {
      lfs: {
        ...(sibling.lfs.size === undefined ? {} : { size: sibling.lfs.size }),
        ...(sibling.lfs.sha256 === undefined ? {} : { sha256: sibling.lfs.sha256 }),
        ...(sibling.lfs.pointerSize === undefined ? {} : { pointersize: sibling.lfs.pointerSize }),
      },
    }),
  };
}

function normalizeRefs(refs: Awaited<ReturnType<HuggingFaceClient['getRefs']>>): Record<string, unknown> | undefined {
  if (!refs) return undefined;
  const mapRef = (ref: HfRef): Record<string, unknown> => ({
    name: ref.name,
    ...(ref.ref === undefined ? {} : { ref: ref.ref }),
    targetcommit: ref.targetCommit,
  });
  return {
    branches: refs.branches.map(mapRef),
    tags: refs.tags.map(mapRef),
    ...(refs.converts === undefined ? {} : { converts: refs.converts.map(mapRef) }),
  };
}

function normalizeRuntime(runtime: HfSpaceRuntime | undefined): Record<string, unknown> | undefined {
  if (!runtime) return undefined;
  return {
    ...(runtime.stage === undefined ? {} : { stage: runtime.stage }),
    ...(runtime.hardware === undefined ? {} : {
      hardware: {
        ...(runtime.hardware.current === undefined ? {} : { current: runtime.hardware.current }),
        ...(runtime.hardware.requested === undefined ? {} : { requested: runtime.hardware.requested }),
      },
    }),
    ...(runtime.resources === undefined ? {} : {
      resources: {
        ...(runtime.resources.cpu === undefined ? {} : { cpu: runtime.resources.cpu }),
        ...(runtime.resources.memory === undefined ? {} : { memory: runtime.resources.memory }),
        ...(runtime.resources.gpu === undefined ? {} : { gpu: runtime.resources.gpu }),
        ...(runtime.resources.gpu_memory === undefined ? {} : { gpu_memory: runtime.resources.gpu_memory }),
      },
    }),
  };
}
function buildVersionDoc(
  base: string,
  type: ResourceType,
  projectedGroupId: string,
  projectedResourceId: string,
  canonicalRepoId: string,
  canonicalGroupId: string,
  commit: { id: string; title?: string; message?: string; date?: string; authors?: ReadonlyArray<{ user?: string; name?: string }>; parents?: readonly string[] },
  isDefault: boolean,
  repoInfo?: { author?: string; siblings?: readonly HfSibling[]; createdAt?: string; lastModified?: string },
): Record<string, unknown> {
  const singular = RESOURCE_SINGULARS[type];
  const vPath = versionPath(type, projectedGroupId, projectedResourceId, commit.id);
  const doc: Record<string, unknown> = {
    versionid: commit.id,
    xid: vPath,
    self: `${resourceUrl(base, type, projectedGroupId, projectedResourceId)}/versions/${encodeURIComponent(commit.id)}`,
    [`${singular}id`]: projectedResourceId,
    epoch: 1,
    createdat: commit.date ?? repoInfo?.lastModified ?? repoInfo?.createdAt ?? STARTUP_TIME,
    modifiedat: commit.date ?? repoInfo?.lastModified ?? repoInfo?.createdAt ?? STARTUP_TIME,
    isdefault: isDefault,
    ancestor: commit.parents?.[0] ?? commit.id,
    name: canonicalRepoId,
    repository: canonicalRepoId,
    repoid: canonicalRepoId,
    namespace: canonicalGroupId === UNNAMESPACED_GROUP_ID ? '' : canonicalGroupId,
    sha: commit.id,
    ...(commit.title === undefined && commit.message === undefined ? {} : { message: commit.title ?? commit.message ?? '' }),
    ...(isDefault && repoInfo?.siblings ? { siblings: repoInfo.siblings.map(normalizeSibling) } : {}),
  };
  const author = commit.authors?.[0]?.user ?? commit.authors?.[0]?.name ?? repoInfo?.author;
  if (author !== undefined) doc['author'] = author;
  return doc;
}

function buildResourceDoc(
  base: string,
  type: ResourceType,
  projectedGroupId: string,
  projectedResourceId: string,
  canonicalGroupId: string,
  repoInfo: HfRepoInfo,
  defaultCommit: { id: string; title?: string; message?: string; date?: string; authors?: ReadonlyArray<{ user?: string; name?: string }>; parents?: readonly string[] } | null,
  versionscount: number,
): Record<string, unknown> {
  const singular = RESOURCE_SINGULARS[type];
  const upstreamIdentity = repoIdToIdentity(repoInfo.id);
  const versionid = repoInfo.sha ?? defaultCommit?.id ?? 'unknown';
  const projected = defaultCommit
    ? buildVersionDoc(
        base,
        type,
        projectedGroupId,
        projectedResourceId,
        upstreamIdentity.canonicalId,
        canonicalGroupId,
        defaultCommit,
        true,
        repoInfo,
      )
    : {
        versionid,
        [`${singular}id`]: projectedResourceId,
        xid: versionPath(type, projectedGroupId, projectedResourceId, versionid),
        self: `${resourceUrl(base, type, projectedGroupId, projectedResourceId)}/versions/${encodeURIComponent(versionid)}`,
        epoch: 1,
        createdat: repoInfo.lastModified ?? repoInfo.createdAt ?? STARTUP_TIME,
        modifiedat: repoInfo.lastModified ?? repoInfo.createdAt ?? STARTUP_TIME,
        isdefault: true,
        ancestor: versionid,
        name: upstreamIdentity.canonicalId,
        repository: upstreamIdentity.canonicalId,
        repoid: upstreamIdentity.canonicalId,
        namespace: canonicalGroupId === UNNAMESPACED_GROUP_ID ? '' : canonicalGroupId,
        sha: versionid,
        ...(repoInfo.author === undefined ? {} : { author: repoInfo.author }),
        ...(repoInfo.siblings === undefined ? {} : { siblings: repoInfo.siblings.map(normalizeSibling) }),
      };
  const rPath = resourcePath(type, projectedGroupId, projectedResourceId);
  const self = resourceUrl(base, type, projectedGroupId, projectedResourceId);
  return {
    ...projected,
    [`${singular}id`]: projectedResourceId,
    xid: rPath,
    self,
    name: upstreamIdentity.canonicalId,
    repository: upstreamIdentity.canonicalId,
    repoid: upstreamIdentity.canonicalId,
    namespace: canonicalGroupId === UNNAMESPACED_GROUP_ID ? '' : canonicalGroupId,
    ...(repoInfo.author === undefined ? {} : { author: repoInfo.author }),
    ...(repoInfo.sha === undefined ? {} : { sha: repoInfo.sha }),
    ...(repoInfo.siblings === undefined ? {} : { siblings: repoInfo.siblings.map(normalizeSibling) }),
    createdat: repoInfo.createdAt ?? defaultCommit?.date ?? repoInfo.lastModified ?? STARTUP_TIME,
    modifiedat: repoInfo.lastModified ?? repoInfo.createdAt ?? defaultCommit?.date ?? STARTUP_TIME,
    ...(repoInfo.description === undefined ? {} : { description: repoInfo.description }),
    metaurl: `${self}/meta`,
    versionsurl: `${self}/versions`,
    versionscount,
  };
}

function originalQuery(req: Request): string {
  const queryIndex = req.originalUrl.indexOf('?');
  return queryIndex === -1 ? '' : req.originalUrl.slice(queryIndex);
}

function canonicalLocation(
  req: Request,
  type: ResourceType,
  projectedGroupId: string,
  projectedResourceId: string,
  suffix = '',
  preserveQuery = false,
): string {
  const query = preserveQuery ? originalQuery(req) : '';
  return `${resourceUrl(getBaseUrl(req), type, projectedGroupId, projectedResourceId)}${suffix}${query}`;
}

type CanonicalRepoInfo = NonNullable<Awaited<ReturnType<HuggingFaceClient['getRepo']>>>;

function repositoryShaCommit(info: CanonicalRepoInfo): HfCommit | null {
  if (!info.sha) return null;
  return {
    id: info.sha,
    ...(info.lastModified ? { date: info.lastModified } : {}),
    ...(info.author ? { authors: [{ user: info.author }] } : {}),
  };
}

async function materializeCommitSnapshot(
  client: HuggingFaceClient,
  type: ResourceType,
  info: CanonicalRepoInfo,
  canonicalId: string,
): Promise<Awaited<ReturnType<HuggingFaceClient['getCommitSnapshot']>>> {
  const snapshot = await client.getCommitSnapshot(type, canonicalId, defaultBranchOf(info));
  if (!info.sha || snapshot.items.some(commit => commit.id === info.sha)) return snapshot;

  const commit = await client.getCommitBySha(type, canonicalId, info.sha) ?? repositoryShaCommit(info);
  if (!commit) return snapshot;
  return {
    ...snapshot,
    items: [...snapshot.items, commit].sort((a, b) =>
      a.id.localeCompare(b.id, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id),
    ),
  };
}

async function loadCanonicalRepo(
  client: HuggingFaceClient,
  type: ResourceType,
  requestedRepoId: string,
): Promise<{ info: CanonicalRepoInfo; identity: ReturnType<typeof repoIdToIdentity> } | null> {
  const info = await client.getRepo(type, requestedRepoId);
  if (!info) return null;
  if (info.id !== requestedRepoId && info.id.toLowerCase() === requestedRepoId.toLowerCase()) return null;
  return { info, identity: repoIdToIdentity(info.id) };
}

async function resolveNamespace(
  client: HuggingFaceClient,
  groupId: string,
): Promise<{ namespace: NamespaceRecord; completeTypes: Record<ResourceType, boolean> } | null> {
  const pages = await Promise.all(RESOURCE_TYPES.map(type =>
    client.listReposByOwner(type, groupId, { limit: 1, skip: 0 }, undefined, true),
  ));
  if (!pages.some(page => page.items.length > 0)) return null;
  const counts: Partial<Record<ResourceType, number>> = {};
  RESOURCE_TYPES.forEach((type, index) => {
    const count = pages[index]?.totalCount;
    if (count !== undefined) counts[type] = count;
  });
  const completeTypes = Object.fromEntries(
    RESOURCE_TYPES.map((type, index) => [type, pages[index]?.totalCount !== undefined]),
  ) as Record<ResourceType, boolean>;
  return { namespace: { id: groupId, counts }, completeTypes };
}

async function projectedGroupIdForCanonicalGroup(client: HuggingFaceClient, canonicalGroupId: string): Promise<string> {
  try {
    const discovery = await client.discoverNamespaces();
    const projections = buildGroupProjections(discovery);
    return projections.find(group => group.canonicalGroupId === canonicalGroupId)?.projectedGroupId ?? canonicalGroupId;
  } catch {
    return canonicalGroupId;
  }
}

async function listProjectedResources(
  client: HuggingFaceClient,
  type: ResourceType,
  canonicalGroupId: string,
): Promise<{ page: Awaited<ReturnType<HuggingFaceClient['listReposByOwner']>>; projections: readonly ResourceProjection[] }> {
  const page = await client.listReposByOwner(type, canonicalGroupId, { limit: MAX_DISCOVERY_ITEMS, skip: 0 }, undefined, true);
  const identities = page.items
    .map(item => repoIdToIdentity(item.id))
    .filter(identity => identity.groupId === canonicalGroupId);
  const projectedIds = projectResourceIds(identities.map(identity => identity.resourceId));
  return {
    page,
    projections: identities.map(identity => ({
      canonicalRepoId: identity.canonicalId,
      canonicalResourceId: identity.resourceId,
      projectedResourceId: projectedIds.get(identity.resourceId) ?? identity.resourceId,
    })),
  };
}

async function projectedResourceIdForCanonicalRepo(
  client: HuggingFaceClient,
  type: ResourceType,
  identity: ReturnType<typeof repoIdToIdentity>,
): Promise<string> {
  try {
    const projected = await listProjectedResources(client, type, identity.groupId);
    return projected.projections.find(item => item.canonicalRepoId === identity.canonicalId)?.projectedResourceId ?? identity.resourceId;
  } catch {
    return identity.resourceId;
  }
}
async function resolveGroupProjection(client: HuggingFaceClient, requestedGroupId: string): Promise<{ group: GroupProjection | null; wrongCase: boolean }> {
  const lowercase = requestedGroupId.toLowerCase();
  if (requestedGroupId === UNNAMESPACED_GROUP_ID || (!isHashedEntityId(requestedGroupId) && isValidRepoPart(requestedGroupId))) {
    const direct = await resolveNamespace(client, requestedGroupId);
    if (direct) {
      return {
        group: {
          canonicalGroupId: direct.namespace.id,
          projectedGroupId: await projectedGroupIdForCanonicalGroup(client, direct.namespace.id),
          namespace: direct.namespace,
          completeTypes: direct.completeTypes,
        },
        wrongCase: false,
      };
    }
  }

  try {
    const discovery = await client.discoverNamespaces();
    const groups = buildGroupProjections(discovery);
    const exact = groups.find(group => group.projectedGroupId === requestedGroupId || group.canonicalGroupId === requestedGroupId) ?? null;
    if (exact) return { group: exact, wrongCase: false };
    const wrongCase = groups.some(group =>
      group.projectedGroupId.toLowerCase() === lowercase || group.canonicalGroupId.toLowerCase() === lowercase,
    );
    return { group: null, wrongCase };
  } catch {
    return { group: null, wrongCase: false };
  }
}

async function buildExactResource(
  client: HuggingFaceClient,
  base: string,
  type: ResourceType,
  requestedRepoId: string,
  projection?: { projectedGroupId: string; projectedResourceId: string },
): Promise<ExactResource | null> {
  const canonical = await loadCanonicalRepo(client, type, requestedRepoId);
  if (!canonical) return null;
  const canonicalId = canonical.identity.canonicalId;
  const projectedGroupId = projection?.projectedGroupId ?? await projectedGroupIdForCanonicalGroup(client, canonical.identity.groupId);
  const projectedResourceId = projection?.projectedResourceId ?? await projectedResourceIdForCanonicalRepo(client, type, canonical.identity);
  const [refs, snapshot] = await Promise.all([
    client.getRefs(type, canonicalId),
    materializeCommitSnapshot(client, type, canonical.info, canonicalId),
  ]);
  const head = canonical.info.sha
    ? snapshot.items.find(commit => commit.id === canonical.info.sha) ?? null
    : snapshot.items.at(-1) ?? null;
  const versionscount = snapshot.items.length || 1;
  return {
    canonicalIdentity: canonical.identity,
    projectedGroupId,
    projectedResourceId,
    info: canonical.info,
    refs,
    versionscount,
    entity: buildResourceDoc(
      base,
      type,
      projectedGroupId,
      projectedResourceId,
      canonical.identity.groupId,
      canonical.info,
      head,
      versionscount,
    ),
  };
}

async function buildMetaDoc(
  base: string,
  type: ResourceType,
  resolved: ExactResource,
): Promise<Record<string, unknown>> {
  const resourceId = resolved.projectedResourceId;
  const resourceSelf = resourceUrl(base, type, resolved.projectedGroupId, resourceId);
  const versionid = String(resolved.entity['versionid']);
  const info = resolved.info;
  const refs = normalizeRefs(resolved.refs);
  const runtime = normalizeRuntime(info.runtime);
  return {
    [`${RESOURCE_SINGULARS[type]}id`]: resourceId,
    xid: `${resourcePath(type, resolved.projectedGroupId, resourceId)}/meta`,
    self: `${resourceSelf}/meta`,
    epoch: 1,
    createdat: info.createdAt ?? info.lastModified ?? STARTUP_TIME,
    modifiedat: info.lastModified ?? info.createdAt ?? STARTUP_TIME,
    readonly: true,
    compatibility: 'none',
    defaultversionid: versionid,
    defaultversionurl: `${resourceSelf}/versions/${encodeURIComponent(versionid)}`,
    defaultversionsticky: false,
    private: info.private ?? false,
    gated: info.gated ?? false,
    ...(info.disabled === undefined ? {} : { disabled: info.disabled }),
    ...(info.usedStorage === undefined ? {} : { used_storage: info.usedStorage }),
    likes: info.likes ?? 0,
    tags: info.tags ?? [],
    ...(info.cardData === undefined ? {} : { card_data: info.cardData }),
    ...(refs === undefined ? {} : { refs }),
    ...(type === 'spaces' ? {} : { downloads: info.downloads ?? 0 }),
    ...(type === 'models' && info.pipeline_tag !== undefined ? { pipeline_tag: info.pipeline_tag } : {}),
    ...(type === 'models' && info.library_name !== undefined ? { library_name: info.library_name } : {}),
    ...(type === 'models' && info.config !== undefined ? { config: info.config } : {}),
    ...(type === 'models' && info.transformersInfo !== undefined ? { transformers_info: info.transformersInfo } : {}),
    ...(type === 'models' && info.safetensors !== undefined ? { safetensors: info.safetensors } : {}),
    ...(type === 'models' && info['model-index'] !== undefined ? { model_index: info['model-index'] } : {}),
    ...(type === 'models' && info.inference !== undefined ? { inference: info.inference } : {}),
    ...(type === 'models' && info.widgetData !== undefined ? { widget_data: info.widgetData } : {}),
    ...(type === 'datasets' && info.paperswithcode_id !== undefined ? { paperswithcode_id: info.paperswithcode_id } : {}),
    ...(type === 'spaces' && info.sdk !== undefined ? { sdk: info.sdk } : {}),
    ...(type === 'spaces' && runtime !== undefined ? { runtime } : {}),
    ...(type === 'spaces' && info.subdomain !== undefined ? { subdomain: info.subdomain } : {}),
    ...(type === 'spaces' && info.host !== undefined ? { host: info.host } : {}),
  };
}

async function resolveRequestedResource(
  client: HuggingFaceClient,
  type: ResourceType,
  group: GroupProjection,
  requestedResourceId: string,
): Promise<{ canonicalRepoId: string; projectedResourceId: string; wrongCase: boolean } | null> {
  if (!isHashedEntityId(requestedResourceId) && isValidRepoPart(requestedResourceId)) {
    const repoId = identityToRepoId(group.canonicalGroupId, requestedResourceId);
    const exact = await loadCanonicalRepo(client, type, repoId);
    if (exact) {
      const projectedResourceId = await projectedResourceIdForCanonicalRepo(client, type, exact.identity);
      return { canonicalRepoId: exact.identity.canonicalId, projectedResourceId, wrongCase: false };
    }
  }

  const projected = await listProjectedResources(client, type, group.canonicalGroupId);
  const exact = projected.projections.find(item =>
    item.projectedResourceId === requestedResourceId || item.canonicalResourceId === requestedResourceId,
  );
  if (exact) {
    return { canonicalRepoId: exact.canonicalRepoId, projectedResourceId: exact.projectedResourceId, wrongCase: false };
  }

  const lowercase = requestedResourceId.toLowerCase();
  const wrongCase = projected.projections.some(item =>
    item.projectedResourceId.toLowerCase() === lowercase || item.canonicalResourceId.toLowerCase() === lowercase,
  );
  return wrongCase ? { canonicalRepoId: '', projectedResourceId: '', wrongCase: true } : null;
}

function sendMigration(req: Request, res: Response, segments: readonly string[]): void {
  const resource = segments[3];
  const legacy = resource ? decodeLegacyRepoId(resource) : null;
  const resourceType = RESOURCE_TYPES.includes(segments[2] as ResourceType)
    ? segments[2]!
    : '{models|datasets|spaces}';
  const suffix = segments.slice(4).map(segment => `/${encodeURIComponent(segment)}`).join('');
  const replacement = legacy
    ? `/${GROUP_TYPE}/${encodeURIComponent(legacy.groupId)}/${resourceType}/${encodeURIComponent(legacy.resourceId)}${suffix}`
    : `/${GROUP_TYPE}/{owner}/${resourceType}/{repository}${suffix}`;
  res.status(410).json(problem(
    410,
    'Hugging Face path migrated',
    'The fixed huggingface.co group and owner~repository resource IDs were removed.',
    req.originalUrl,
    { type: 'https://github.com/xregistry/xrproxy/issues/203', replacement },
  ));
}

function decodedRequestSegments(req: Request): string[] | null {
  try {
    return req.originalUrl.split('?', 1)[0]!.split('/').filter(Boolean).map(segment => decodeURIComponent(segment));
  } catch {
    return null;
  }
}

export function setupRoutes(app: Express, _config: HfConfig, client: HuggingFaceClient): void {
  app.use((req: Request, res: Response, next: NextFunction) => {
    const segments = decodedRequestSegments(req);
    if (!segments) {
      res.status(400).json(problem(400, 'Malformed URL encoding', undefined, req.originalUrl));
      return;
    }
    if (
      segments[0] === GROUP_TYPE &&
      segments[1]?.toLowerCase() === LEGACY_HF_GROUP_ID &&
      segments[1] !== LEGACY_HF_GROUP_ID
    ) {
      res.status(404).json(problem(404, 'Not found', undefined, req.originalUrl));
      return;
    }
    if (segments[0] === GROUP_TYPE && segments[1] === LEGACY_HF_GROUP_ID) {
      sendMigration(req, res, segments);
      return;
    }
    next();
  });

  app.get('/', async (req: Request, res: Response) => {
    const base = getBaseUrl(req);
    let groupCount: number | undefined;
    try {
      const discovery = await client.discoverNamespaces();
      if (discovery.complete) groupCount = discovery.namespaces.length;
    } catch {
      // Keep bootstrap available and omit an unknown count.
    }
    setCacheMutable(res);
    res.json({
      specversion: SPEC_VERSION,
      registryid: REGISTRY_ID,
      xid: '/',
      name: REGISTRY_NAME,
      self: `${base}/`,
      description: 'Hugging Face repositories grouped by owner namespace; immutable versions are commit SHAs.',
      epoch: 1,
      createdat: STARTUP_TIME,
      modifiedat: STARTUP_TIME,
      [`${GROUP_TYPE}url`]: `${base}/${GROUP_TYPE}`,
      ...(groupCount !== undefined ? { [`${GROUP_TYPE}count`]: groupCount } : {}),
    });
  });

  app.get(`/${GROUP_TYPE}`, async (req: Request, res: Response) => {
    if (rejectUnsupportedSort(req, res)) return;
    const limit = parseLimit(req);
    const offset = parseOffset(req);
    const filter = entityFilter(req.query['filter'], ['name', `${GROUP_SINGULAR}id`, 'namespace', 'epoch']);
    if (filter === null) {
      res.status(400).json(problem(400, 'Invalid filter', `Supported attributes: name, ${GROUP_SINGULAR}id, namespace, epoch`));
      return;
    }
    try {
      const discovery = await client.discoverNamespaces();
      const entities = buildGroupProjections(discovery).map(group => ({
        group,
        entity: buildGroupDoc(getBaseUrl(req), group),
      }));
      const filtered = entities.filter(({ entity }) => matchesEntityFilter(entity, filter));
      const page = filtered.slice(offset, offset + limit);
      const body: Record<string, unknown> = {};
      for (const { group, entity } of page) body[group.projectedGroupId] = entity;
      setPagination(req, res, offset, limit, {
        ...(discovery.complete ? { totalCount: filtered.length } : {}),
        hasMore: offset + limit < filtered.length,
      });
      res.setHeader('X-Collection-Complete', String(discovery.complete));
      setCacheMutable(res);
      res.json(body);
    } catch (error) {
      console.error('[HF] namespace discovery error', error);
      res.status(502).json(problem(502, 'Bad Gateway', 'Failed to discover Hugging Face namespaces'));
    }
  });
  app.get(`/${GROUP_TYPE}/:groupId`, async (req: Request, res: Response) => {
    const requestedGroupId = rp(req, 'groupId');
    if (requestedGroupId !== UNNAMESPACED_GROUP_ID && !isValidRepoPart(requestedGroupId) && !isHashedEntityId(requestedGroupId)) {
      res.status(400).json(problem(400, 'Invalid namespace ID'));
      return;
    }
    try {
      const resolved = await resolveGroupProjection(client, requestedGroupId);
      if (!resolved.group) {
        res.status(404).json(problem(404, 'Namespace not found'));
        return;
      }
      if (resolved.group.projectedGroupId !== requestedGroupId) {
        res.redirect(308, `${getBaseUrl(req)}/${GROUP_TYPE}/${encodeURIComponent(resolved.group.projectedGroupId)}`);
        return;
      }
      setCacheMutable(res);
      res.json(buildGroupDoc(getBaseUrl(req), resolved.group));
    } catch (error) {
      if (error instanceof PrefixSearchLimitError) {
        res.status(400).json(problem(400, 'Namespace discovery too broad'));
        return;
      }
      res.status(502).json(problem(502, 'Bad Gateway'));
    }
  });

  app.get(`/${GROUP_TYPE}/:groupId/:resourceType`, async (req: Request, res: Response) => {
    if (rejectUnsupportedSort(req, res)) return;
    const requestedGroupId = rp(req, 'groupId');
    const rawType = rp(req, 'resourceType');
    if (!RESOURCE_TYPES.includes(rawType as ResourceType)) {
      res.status(404).json(problem(404, 'Resource type not found'));
      return;
    }
    if (requestedGroupId !== UNNAMESPACED_GROUP_ID && !isValidRepoPart(requestedGroupId) && !isHashedEntityId(requestedGroupId)) {
      res.status(400).json(problem(400, 'Invalid namespace ID'));
      return;
    }
    const type = rawType as ResourceType;
    const limit = parseLimit(req);
    const offset = parseOffset(req);
    const resolvedGroup = await resolveGroupProjection(client, requestedGroupId);
    if (!resolvedGroup.group) {
      res.status(404).json(problem(404, 'Namespace not found'));
      return;
    }
    if (resolvedGroup.group!.projectedGroupId !== requestedGroupId) {
      res.redirect(308, `${getBaseUrl(req)}/${GROUP_TYPE}/${encodeURIComponent(resolvedGroup.group!.projectedGroupId)}/${type}${originalQuery(req)}`);
      return;
    }
    const singularId = `${RESOURCE_SINGULARS[type]}id`;
    const filter = entityFilter(req.query['filter'], [
      'name', 'repository', singularId, 'repoid', 'namespace', 'epoch',
      'author', 'sha',
    ]);
    if (filter === null) {
      res.status(400).json(problem(400, 'Invalid filter', `Unsupported ${type} filter attribute`));
      return;
    }
    if (filter !== undefined && offset > MAX_FILTERED_SKIP) {
      res.status(400).json(problem(400, 'Filtered offset too large', `Filtered collections support offsets up to ${MAX_FILTERED_SKIP}`));
      return;
    }

    const detailFilter = filter !== undefined && ['author', 'sha'].includes(filter.attribute);
    if (detailFilter && offset >= MAX_DETAIL_FILTER_HYDRATIONS) {
      res.status(400).json(problem(
        400,
        'Detail filter offset too large',
        `Filters on ${filter.attribute} hydrate at most ${MAX_DETAIL_FILTER_HYDRATIONS} repositories.`,
      ));
      return;
    }

    try {
      const projected = await listProjectedResources(client, type, resolvedGroup.group.canonicalGroupId);
      const itemsByRepoId = new Map(projected.page.items.map(item => [item.id, item]));
      const summaries = projected.projections.map(item => {
        const summary = itemsByRepoId.get(item.canonicalRepoId)!;
        return {
          item: summary,
          projection: item,
          entity: buildResourceDoc(
            getBaseUrl(req),
            type,
            resolvedGroup.group!.projectedGroupId,
            item.projectedResourceId,
            resolvedGroup.group!.canonicalGroupId,
            summary,
            null,
            summary.sha ? 1 : 0,
          ),
        };
      });

      if (detailFilter) {
        const candidates = summaries.slice(0, MAX_DETAIL_FILTER_HYDRATIONS);
        const hydrated = await Promise.all(candidates.map(candidate =>
          buildExactResource(client, getBaseUrl(req), type, candidate.item.id, {
            projectedGroupId: resolvedGroup.group!.projectedGroupId,
            projectedResourceId: candidate.projection.projectedResourceId,
          }),
        ));
        const filtered = hydrated.filter((item): item is NonNullable<typeof item> =>
          item !== null && matchesEntityFilter(item.entity, filter),
        );
        const selected = filtered.slice(offset, offset + limit);
        const body: Record<string, unknown> = {};
        for (const item of selected) body[item.projectedResourceId] = item.entity;

        const complete = projected.page.totalCount !== undefined && projected.page.totalCount <= MAX_DETAIL_FILTER_HYDRATIONS;
        setPagination(req, res, offset, limit, {
          ...(complete ? { totalCount: filtered.length } : {}),
          hasMore: offset + limit < filtered.length,
        });
        res.setHeader('X-Collection-Complete', String(complete));
        if (!complete) res.setHeader('Warning', '299 - "Filtered Hugging Face snapshot is incomplete"');
        setCacheMutable(res);
        res.json(body);
        return;
      }

      const filtered = summaries.filter(item => matchesEntityFilter(item.entity, filter));
      const selected = filtered.slice(offset, offset + limit);
      const resolved = await Promise.all(selected.map(item =>
        buildExactResource(client, getBaseUrl(req), type, item.item.id, {
          projectedGroupId: resolvedGroup.group!.projectedGroupId,
          projectedResourceId: item.projection.projectedResourceId,
        }),
      ));
      const body: Record<string, unknown> = {};
      for (const item of resolved) {
        if (!item || !matchesEntityFilter(item.entity, filter)) continue;
        body[item.projectedResourceId] = item.entity;
      }
      setPagination(req, res, offset, limit, {
        ...(projected.page.totalCount === undefined ? {} : { totalCount: filtered.length }),
        hasMore: offset + limit < filtered.length,
      });
      res.setHeader('X-Collection-Complete', String(projected.page.totalCount !== undefined));
      setCacheMutable(res);
      res.json(body);
    } catch (error) {
      if (error instanceof PrefixSearchLimitError) {
        res.status(400).json(problem(400, 'Filtered search too broad', 'Use a more specific filter or smaller offset'));
        return;
      }
      console.error('[HF] list owner repositories error', error);
      res.status(502).json(problem(502, 'Bad Gateway'));
    }
  });

  app.get(`/${GROUP_TYPE}/:groupId/:resourceType/:repoId`, async (req: Request, res: Response) => {
    const rawType = rp(req, 'resourceType');
    const requestedGroupId = rp(req, 'groupId');
    const requestedResourceId = rp(req, 'repoId');
    if (!RESOURCE_TYPES.includes(rawType as ResourceType)) { res.status(404).json(problem(404, 'Resource type not found')); return; }
    if (requestedGroupId !== UNNAMESPACED_GROUP_ID && !isValidRepoPart(requestedGroupId) && !isHashedEntityId(requestedGroupId)) { res.status(400).json(problem(400, 'Invalid namespace ID')); return; }
    if (!isValidRepoPart(requestedResourceId) && !isHashedEntityId(requestedResourceId)) { res.status(400).json(problem(400, 'Invalid repository identity', 'Group and resource entity IDs must not contain slashes.')); return; }
    const type = rawType as ResourceType;
    try {
      const directRepoId = !isHashedEntityId(requestedGroupId) && !isHashedEntityId(requestedResourceId)
        ? (() => { try { return identityToRepoId(requestedGroupId, requestedResourceId); } catch { return null; } })()
        : null;
      if (directRepoId) {
        const direct = await buildExactResource(client, getBaseUrl(req), type, directRepoId);
        if (direct) {
          if (direct.projectedGroupId !== requestedGroupId || direct.projectedResourceId !== requestedResourceId) {
            res.redirect(308, canonicalLocation(req, type, direct.projectedGroupId, direct.projectedResourceId, '', true));
            return;
          }
          setCacheMutable(res);
          res.json(direct.entity);
          return;
        }
      }

      const resolvedGroup = await resolveGroupProjection(client, requestedGroupId);
      if (!resolvedGroup.group) { res.status(404).json(problem(404, 'Not found')); return; }
      const requested = await resolveRequestedResource(client, type, resolvedGroup.group, requestedResourceId);
      if (!requested || requested.wrongCase) { res.status(404).json(problem(404, 'Not found')); return; }
      const resolved = await buildExactResource(client, getBaseUrl(req), type, requested.canonicalRepoId, {
        projectedGroupId: resolvedGroup.group!.projectedGroupId,
        projectedResourceId: requested.projectedResourceId,
      });
      if (!resolved) { res.status(404).json(problem(404, 'Not found')); return; }
      if (resolved.projectedGroupId !== requestedGroupId || resolved.projectedResourceId !== requestedResourceId) {
        res.redirect(308, canonicalLocation(req, type, resolved.projectedGroupId, resolved.projectedResourceId, '', true));
        return;
      }
      setCacheMutable(res);
      res.json(resolved.entity);
    } catch (error) {
      console.error('[HF] get repository error', error);
      res.status(502).json(problem(502, 'Bad Gateway'));
    }
  });

  app.get(`/${GROUP_TYPE}/:groupId/:resourceType/:repoId/meta`, async (req: Request, res: Response) => {
    const rawType = rp(req, 'resourceType');
    const requestedGroupId = rp(req, 'groupId');
    const requestedResourceId = rp(req, 'repoId');
    if (!RESOURCE_TYPES.includes(rawType as ResourceType)) { res.status(404).json(problem(404, 'Resource type not found')); return; }
    if (!isValidRepoPart(requestedResourceId) && !isHashedEntityId(requestedResourceId)) { res.status(400).json(problem(400, 'Invalid repository identity')); return; }
    const type = rawType as ResourceType;
    try {
      const directRepoId = !isHashedEntityId(requestedGroupId) && !isHashedEntityId(requestedResourceId)
        ? (() => { try { return identityToRepoId(requestedGroupId, requestedResourceId); } catch { return null; } })()
        : null;
      if (directRepoId) {
        const direct = await buildExactResource(client, getBaseUrl(req), type, directRepoId);
        if (direct) {
          if (direct.projectedGroupId !== requestedGroupId || direct.projectedResourceId !== requestedResourceId) {
            res.redirect(308, canonicalLocation(req, type, direct.projectedGroupId, direct.projectedResourceId, '/meta', true));
            return;
          }
          setCacheMutable(res);
          res.json(await buildMetaDoc(getBaseUrl(req), type, direct));
          return;
        }
      }

      const resolvedGroup = await resolveGroupProjection(client, requestedGroupId);
      if (!resolvedGroup.group) { res.status(404).json(problem(404, 'Not found')); return; }
      const requested = await resolveRequestedResource(client, type, resolvedGroup.group, requestedResourceId);
      if (!requested || requested.wrongCase) { res.status(404).json(problem(404, 'Not found')); return; }
      const resolved = await buildExactResource(client, getBaseUrl(req), type, requested.canonicalRepoId, {
        projectedGroupId: resolvedGroup.group!.projectedGroupId,
        projectedResourceId: requested.projectedResourceId,
      });
      if (!resolved) { res.status(404).json(problem(404, 'Not found')); return; }
      if (resolved.projectedGroupId !== requestedGroupId || resolved.projectedResourceId !== requestedResourceId) {
        res.redirect(308, canonicalLocation(req, type, resolved.projectedGroupId, resolved.projectedResourceId, '/meta', true));
        return;
      }
      setCacheMutable(res);
      res.json(await buildMetaDoc(getBaseUrl(req), type, resolved));
    } catch (error) {
      console.error('[HF] get repository meta error', error);
      res.status(502).json(problem(502, 'Bad Gateway'));
    }
  });
  app.get(`/${GROUP_TYPE}/:groupId/:resourceType/:repoId/versions`, async (req: Request, res: Response) => {
    const rawType = rp(req, 'resourceType');
    const requestedGroupId = rp(req, 'groupId');
    const requestedResourceId = rp(req, 'repoId');
    if (!RESOURCE_TYPES.includes(rawType as ResourceType)) { res.status(404).json(problem(404, 'Resource type not found')); return; }
    if (!isValidRepoPart(requestedResourceId) && !isHashedEntityId(requestedResourceId)) { res.status(400).json(problem(400, 'Invalid repository identity')); return; }
    const type = rawType as ResourceType;
    try {
      const directRepoId = !isHashedEntityId(requestedGroupId) && !isHashedEntityId(requestedResourceId)
        ? (() => { try { return identityToRepoId(requestedGroupId, requestedResourceId); } catch { return null; } })()
        : null;
      if (directRepoId) {
        const direct = await buildExactResource(client, getBaseUrl(req), type, directRepoId);
        if (direct) {
          if (direct.projectedGroupId !== requestedGroupId || direct.projectedResourceId !== requestedResourceId) {
            res.redirect(308, canonicalLocation(req, type, direct.projectedGroupId, direct.projectedResourceId, '/versions', true));
            return;
          }
          if (rejectUnsupportedSort(req, res)) return;
          const limit = parseLimit(req);
          const offset = parseOffset(req);
          const snapshot = await materializeCommitSnapshot(client, type, direct.info, direct.canonicalIdentity.canonicalId);
          const selected = snapshot.items.slice(offset, offset + limit);
          const body = Object.fromEntries(selected.map(commit => [
            commit.id,
            buildVersionDoc(
              getBaseUrl(req),
              type,
              direct.projectedGroupId,
              direct.projectedResourceId,
              direct.canonicalIdentity.canonicalId,
              direct.canonicalIdentity.groupId,
              commit,
              commit.id === direct.info.sha,
              commit.id === direct.info.sha ? direct.info : undefined,
            ),
          ]));
          setPagination(req, res, offset, limit, {
            ...(snapshot.complete ? { totalCount: snapshot.items.length } : {}),
            hasMore: snapshot.items.length > offset + limit,
          });
          res.setHeader('X-Collection-Complete', String(snapshot.complete));
          if (!snapshot.complete) res.setHeader('Warning', '299 - "Hugging Face commit snapshot is bounded"');
          setCacheMutable(res, 60);
          res.json(body);
          return;
        }
      }

      const resolvedGroup = await resolveGroupProjection(client, requestedGroupId);
      if (!resolvedGroup.group) { res.status(404).json(problem(404, 'Not found')); return; }
      const requested = await resolveRequestedResource(client, type, resolvedGroup.group, requestedResourceId);
      if (!requested || requested.wrongCase) { res.status(404).json(problem(404, 'Not found')); return; }
      const canonical = await loadCanonicalRepo(client, type, requested.canonicalRepoId);
      if (!canonical) { res.status(404).json(problem(404, 'Not found')); return; }
      if (resolvedGroup.group!.projectedGroupId !== requestedGroupId || requested.projectedResourceId !== requestedResourceId) {
        res.redirect(308, canonicalLocation(req, type, resolvedGroup.group!.projectedGroupId, requested.projectedResourceId, '/versions', true));
        return;
      }
      if (rejectUnsupportedSort(req, res)) return;
      const limit = parseLimit(req);
      const offset = parseOffset(req);
      const snapshot = await materializeCommitSnapshot(client, type, canonical.info, canonical.identity.canonicalId);
      const selected = snapshot.items.slice(offset, offset + limit);
      const body = Object.fromEntries(selected.map(commit => [
        commit.id,
        buildVersionDoc(
          getBaseUrl(req),
          type,
          resolvedGroup.group!.projectedGroupId,
          requested.projectedResourceId,
          canonical.identity.canonicalId,
          canonical.identity.groupId,
          commit,
          commit.id === canonical.info.sha,
          commit.id === canonical.info.sha ? canonical.info : undefined,
        ),
      ]));
      setPagination(req, res, offset, limit, {
        ...(snapshot.complete ? { totalCount: snapshot.items.length } : {}),
        hasMore: snapshot.items.length > offset + limit,
      });
      res.setHeader('X-Collection-Complete', String(snapshot.complete));
      if (!snapshot.complete) res.setHeader('Warning', '299 - "Hugging Face commit snapshot is bounded"');
      setCacheMutable(res, 60);
      res.json(body);
    } catch (error) {
      console.error('[HF] list commits error', error);
      res.status(502).json(problem(502, 'Bad Gateway'));
    }
  });

  app.get(`/${GROUP_TYPE}/:groupId/:resourceType/:repoId/versions/:sha`, async (req: Request, res: Response) => {
    const rawType = rp(req, 'resourceType');
    const requestedGroupId = rp(req, 'groupId');
    const requestedResourceId = rp(req, 'repoId');
    const sha = rp(req, 'sha');
    if (!RESOURCE_TYPES.includes(rawType as ResourceType)) { res.status(404).json(problem(404, 'Resource type not found')); return; }
    if (!isValidRepoPart(requestedResourceId) && !isHashedEntityId(requestedResourceId)) { res.status(400).json(problem(400, 'Invalid repository identity')); return; }
    if (!/^[0-9a-f]{4,64}$/i.test(sha)) { res.status(400).json(problem(400, 'Invalid version ID')); return; }
    const type = rawType as ResourceType;
    try {
      const directRepoId = !isHashedEntityId(requestedGroupId) && !isHashedEntityId(requestedResourceId)
        ? (() => { try { return identityToRepoId(requestedGroupId, requestedResourceId); } catch { return null; } })()
        : null;
      if (directRepoId) {
        const direct = await buildExactResource(client, getBaseUrl(req), type, directRepoId);
        if (direct) {
          if (direct.projectedGroupId !== requestedGroupId || direct.projectedResourceId !== requestedResourceId) {
            res.redirect(308, canonicalLocation(req, type, direct.projectedGroupId, direct.projectedResourceId, `/versions/${encodeURIComponent(sha)}`, true));
            return;
          }
          const commit = await client.getCommitBySha(type, direct.canonicalIdentity.canonicalId, sha)
            ?? (direct.info.sha === sha ? repositoryShaCommit(direct.info) : null);
          if (!commit) { res.status(404).json(problem(404, 'Version not found')); return; }
          setCacheImmutable(res);
          res.json(buildVersionDoc(
            getBaseUrl(req),
            type,
            direct.projectedGroupId,
            direct.projectedResourceId,
            direct.canonicalIdentity.canonicalId,
            direct.canonicalIdentity.groupId,
            commit,
            commit.id === direct.info.sha,
            commit.id === direct.info.sha ? direct.info : undefined,
          ));
          return;
        }
      }

      const resolvedGroup = await resolveGroupProjection(client, requestedGroupId);
      if (!resolvedGroup.group) { res.status(404).json(problem(404, 'Not found')); return; }
      const requested = await resolveRequestedResource(client, type, resolvedGroup.group, requestedResourceId);
      if (!requested || requested.wrongCase) { res.status(404).json(problem(404, 'Not found')); return; }
      const canonical = await loadCanonicalRepo(client, type, requested.canonicalRepoId);
      if (!canonical) { res.status(404).json(problem(404, 'Not found')); return; }
      if (resolvedGroup.group!.projectedGroupId !== requestedGroupId || requested.projectedResourceId !== requestedResourceId) {
        res.redirect(308, canonicalLocation(req, type, resolvedGroup.group!.projectedGroupId, requested.projectedResourceId, `/versions/${encodeURIComponent(sha)}`, true));
        return;
      }
      const commit = await client.getCommitBySha(type, canonical.identity.canonicalId, sha)
        ?? (canonical.info.sha === sha ? repositoryShaCommit(canonical.info) : null);
      if (!commit) { res.status(404).json(problem(404, 'Version not found')); return; }
      setCacheImmutable(res);
      res.json(buildVersionDoc(
        getBaseUrl(req),
        type,
        resolvedGroup.group!.projectedGroupId,
        requested.projectedResourceId,
        canonical.identity.canonicalId,
        canonical.identity.groupId,
        commit,
        commit.id === canonical.info.sha,
        commit.id === canonical.info.sha ? canonical.info : undefined,
      ));
    } catch (error) {
      console.error('[HF] get commit error', error);
      res.status(502).json(problem(502, 'Bad Gateway'));
    }
  });
}
