import type { Express, NextFunction, Request, Response } from 'express';
import type { HfConfig } from '../config';
import {
  defaultBranchOf,
  MAX_DETAIL_FILTER_HYDRATIONS,
  MAX_DISCOVERY_ITEMS,
  MAX_FILTERED_SKIP,
  PrefixSearchLimitError,
  type HfCommit,
  type HuggingFaceClient,
  type NamespaceRecord,
  type ResourceType,
} from '../hf-client';
import {
  decodeLegacyRepoId,
  identityToRepoId,
  isValidRepoPart,
  LEGACY_HF_GROUP_ID,
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

function buildGroupDoc(
  base: string,
  namespace: NamespaceRecord,
  completeTypes: Readonly<Record<ResourceType, boolean>>,
): Record<string, unknown> {
  const groupPath = `/${GROUP_TYPE}/${namespace.id}`;
  const self = `${base}/${GROUP_TYPE}/${encodeURIComponent(namespace.id)}`;
  const counts: Record<string, number> = {};
  for (const type of RESOURCE_TYPES) {
    if (completeTypes[type]) counts[`${type}count`] = namespace.counts[type] ?? 0;
  }
  return {
    [`${GROUP_SINGULAR}id`]: namespace.id,
    xid: groupPath,
    self,
    name: namespace.id === UNNAMESPACED_GROUP_ID ? 'Unnamespaced repositories' : namespace.id,
    namespace: namespace.id === UNNAMESPACED_GROUP_ID ? '' : namespace.id,
    epoch: 1,
    createdat: STARTUP_TIME,
    modifiedat: STARTUP_TIME,
    ...Object.fromEntries(RESOURCE_TYPES.map(type => [`${type}url`, `${self}/${type}`])),
    ...counts,
  };
}

function buildResourceDoc(
  base: string,
  type: ResourceType,
  groupId: string,
  resourceId: string,
  repoInfo: {
    id: string; author?: string; sha?: string; lastModified?: string;
  },
  defaultCommit: { id: string; title?: string; message?: string; date?: string; authors?: ReadonlyArray<{ user?: string; name?: string }>; parents?: readonly string[] } | null,
  versionscount: number,
): Record<string, unknown> {
  const singular = RESOURCE_SINGULARS[type];
  const upstreamIdentity = repoIdToIdentity(repoInfo.id);
  if (upstreamIdentity.groupId !== groupId || upstreamIdentity.resourceId !== resourceId) {
    throw new Error(`Hugging Face canonical identity mismatch: ${repoInfo.id}`);
  }
  const versionid = repoInfo.sha ?? defaultCommit?.id ?? 'unknown';
  const projected = defaultCommit
    ? buildVersionDoc(base, type, groupId, resourceId, defaultCommit, true)
    : {
        versionid,
        [`${singular}id`]: resourceId,
        xid: versionPath(type, groupId, resourceId, versionid),
        self: `${resourceUrl(base, type, groupId, resourceId)}/versions/${encodeURIComponent(versionid)}`,
        epoch: 1,
        createdat: repoInfo.lastModified ?? STARTUP_TIME,
        modifiedat: repoInfo.lastModified ?? STARTUP_TIME,
        isdefault: true,
        ancestor: versionid,
        name: upstreamIdentity.canonicalId,
        repository: upstreamIdentity.canonicalId,
        repoid: upstreamIdentity.canonicalId,
        namespace: groupId === UNNAMESPACED_GROUP_ID ? '' : groupId,
        sha: versionid,
        ...(repoInfo.author === undefined ? {} : { author: repoInfo.author }),
      };
  const rPath = resourcePath(type, groupId, resourceId);
  const self = resourceUrl(base, type, groupId, resourceId);
  return {
    ...projected,
    [`${singular}id`]: resourceId,
    xid: rPath,
    self,
    metaurl: `${self}/meta`,
    versionsurl: `${self}/versions`,
    versionscount,
  };
}

function buildVersionDoc(
  base: string,
  type: ResourceType,
  groupId: string,
  resourceId: string,
  commit: { id: string; title?: string; message?: string; date?: string; authors?: ReadonlyArray<{ user?: string; name?: string }>; parents?: readonly string[] },
  isDefault: boolean,
): Record<string, unknown> {
  const singular = RESOURCE_SINGULARS[type];
  const vPath = versionPath(type, groupId, resourceId, commit.id);
  const canonicalId = identityToRepoId(groupId, resourceId);
  const doc: Record<string, unknown> = {
    versionid: commit.id,
    xid: vPath,
    self: `${resourceUrl(base, type, groupId, resourceId)}/versions/${encodeURIComponent(commit.id)}`,
    [`${singular}id`]: resourceId,
    epoch: 1,
    createdat: commit.date ?? STARTUP_TIME,
    modifiedat: commit.date ?? STARTUP_TIME,
    isdefault: isDefault,
    ancestor: commit.parents?.[0] ?? commit.id,
    name: canonicalId,
    repository: canonicalId,
    repoid: canonicalId,
    namespace: groupId === UNNAMESPACED_GROUP_ID ? '' : groupId,
    sha: commit.id,
    message: commit.title ?? commit.message ?? '',
  };
  const author = commit.authors?.[0]?.user ?? commit.authors?.[0]?.name;
  if (author !== undefined) doc['author'] = author;
  return doc;
}

function routeIdentity(req: Request): { groupId: string; resourceId: string; repoId: string } | null {
  const groupId = rp(req, 'groupId');
  const resourceId = rp(req, 'repoId');
  try {
    return { groupId, resourceId, repoId: identityToRepoId(groupId, resourceId) };
  } catch {
    return null;
  }
}

function decodedRequestSegments(req: Request): string[] | null {
  try {
    return req.originalUrl.split('?', 1)[0]!.split('/').filter(Boolean).map(segment => decodeURIComponent(segment));
  } catch {
    return null;
  }
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

function originalQuery(req: Request): string {
  const queryIndex = req.originalUrl.indexOf('?');
  return queryIndex === -1 ? '' : req.originalUrl.slice(queryIndex);
}

function canonicalLocation(
  req: Request,
  type: ResourceType,
  identity: { groupId: string; resourceId: string },
  suffix = '',
  preserveQuery = false,
): string {
  const query = preserveQuery ? originalQuery(req) : '';
  return `${resourceUrl(getBaseUrl(req), type, identity.groupId, identity.resourceId)}${suffix}${query}`;
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
): Promise<Awaited<ReturnType<HuggingFaceClient["getCommitSnapshot"]>>> {
  const snapshot = await client.getCommitSnapshot(type, canonicalId, defaultBranchOf(info));
  if (!info.sha || snapshot.items.some(commit => commit.id === info.sha)) return snapshot;

  const commit = await client.getCommitBySha(type, canonicalId, info.sha) ?? repositoryShaCommit(info);
  if (!commit) return snapshot;
  return {
    ...snapshot,
    items: [...snapshot.items, commit].sort((a, b) =>
      a.id.localeCompare(b.id, undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id),
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

async function buildExactResource(
  client: HuggingFaceClient,
  base: string,
  type: ResourceType,
  requestedRepoId: string,
): Promise<{
  identity: ReturnType<typeof repoIdToIdentity>;
  entity: Record<string, unknown>;
  info: CanonicalRepoInfo;
  refs: Awaited<ReturnType<HuggingFaceClient['getRefs']>>;
  versionscount: number;
} | null> {
  const canonical = await loadCanonicalRepo(client, type, requestedRepoId);
  if (!canonical) return null;
  const canonicalId = canonical.identity.canonicalId;
  const [refs, snapshot] = await Promise.all([
    client.getRefs(type, canonicalId),
    materializeCommitSnapshot(client, type, canonical.info, canonicalId),
  ]);
  const head = canonical.info.sha
    ? snapshot.items.find(commit => commit.id === canonical.info.sha) ?? null
    : snapshot.items.at(-1) ?? null;
  const versionscount = snapshot.items.length || 1;
  return {
    identity: canonical.identity,
    info: canonical.info,
    refs,
    versionscount,
    entity: buildResourceDoc(
      base,
      type,
      canonical.identity.groupId,
      canonical.identity.resourceId,
      canonical.info,
      head,
      versionscount,
    ),
  };
}

async function resolveNamespace(
  client: HuggingFaceClient,
  groupId: string,
): Promise<{ pages: Awaited<ReturnType<HuggingFaceClient['listReposByOwner']>>[]; namespace: NamespaceRecord; completeTypes: Record<ResourceType, boolean> } | null> {
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
  return { pages, namespace: { id: groupId, counts }, completeTypes };
}

function buildMetaDoc(
  base: string,
  type: ResourceType,
  resolved: NonNullable<Awaited<ReturnType<typeof buildExactResource>>>,
): Record<string, unknown> {
  const resourceId = resolved.identity.resourceId;
  const rPath = resourcePath(type, resolved.identity.groupId, resourceId);
  const resourceSelf = resourceUrl(base, type, resolved.identity.groupId, resourceId);
  const versionid = String(resolved.entity['versionid']);
  const info = resolved.info;
  return {
    [`${RESOURCE_SINGULARS[type]}id`]: resourceId,
    xid: `${rPath}/meta`,
    self: `${resourceSelf}/meta`,
    epoch: 1,
    createdat: info.lastModified ?? STARTUP_TIME,
    modifiedat: info.lastModified ?? STARTUP_TIME,
    readonly: true,
    compatibility: 'none',
    defaultversionid: versionid,
    defaultversionurl: `${resourceSelf}/versions/${encodeURIComponent(versionid)}`,
    defaultversionsticky: false,
    private: info.private ?? false,
    gated: info.gated ?? false,
    downloads: info.downloads ?? 0,
    likes: info.likes ?? 0,
    tags: info.tags ?? [],
    ...(resolved.refs ? {
      refs: {
        branches: resolved.refs.branches.map(branch => ({ name: branch.name, targetcommit: branch.targetCommit })),
        tags: resolved.refs.tags.map(tag => ({ name: tag.name, targetcommit: tag.targetCommit })),
      },
    } : {}),
    ...(type === 'models' && info.pipeline_tag !== undefined ? { pipeline_tag: info.pipeline_tag } : {}),
    ...(type === 'models' && info.library_name !== undefined ? { library_name: info.library_name } : {}),
    ...(type === 'spaces' && info.sdk !== undefined ? { sdk: info.sdk } : {}),
  };
}

export function setupRoutes(app: Express, _config: HfConfig, client: HuggingFaceClient): void {
  // Decode once before Express route matching so encoded legacy sentinels cannot
  // bypass the 410 response and malformed escapes are a deterministic 400.
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
      const entities = discovery.namespaces.map(namespace => ({
        namespace,
        entity: buildGroupDoc(getBaseUrl(req), namespace, discovery.completeTypes),
      }));
      const filtered = entities.filter(({ entity }) => matchesEntityFilter(entity, filter));
      const page = filtered.slice(offset, offset + limit);
      const body: Record<string, unknown> = {};
      for (const { namespace, entity } of page) body[namespace.id] = entity;
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
    const groupId = rp(req, 'groupId');
    if (groupId !== UNNAMESPACED_GROUP_ID && !isValidRepoPart(groupId)) {
      res.status(400).json(problem(400, 'Invalid namespace ID'));
      return;
    }
    try {
      const resolved = await resolveNamespace(client, groupId);
      if (!resolved) {
        res.status(404).json(problem(404, 'Namespace not found'));
        return;
      }
      setCacheMutable(res);
      res.json(buildGroupDoc(getBaseUrl(req), resolved.namespace, resolved.completeTypes));
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
    const groupId = rp(req, 'groupId');
    const rawType = rp(req, 'resourceType');
    if (!RESOURCE_TYPES.includes(rawType as ResourceType)) {
      res.status(404).json(problem(404, 'Resource type not found'));
      return;
    }
    if (groupId !== UNNAMESPACED_GROUP_ID && !isValidRepoPart(groupId)) {
      res.status(400).json(problem(400, 'Invalid namespace ID'));
      return;
    }
    const type = rawType as ResourceType;
    const limit = parseLimit(req);
    const offset = parseOffset(req);
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
      const namespace = await resolveNamespace(client, groupId);
      if (!namespace) {
        res.status(404).json(problem(404, 'Namespace not found'));
        return;
      }
      if (detailFilter) {
        // List summaries can omit author/SHA. Hydrate a strictly bounded
        // candidate snapshot before evaluating those fields.
        const scan = await client.listReposByOwner(
          type,
          groupId,
          { limit: MAX_DETAIL_FILTER_HYDRATIONS + 1, skip: 0 },
        );
        const candidates = scan.items.slice(0, MAX_DETAIL_FILTER_HYDRATIONS);
        const hydrated = await Promise.all(candidates.map(item =>
          buildExactResource(client, getBaseUrl(req), type, item.id),
        ));
        const filtered = hydrated.filter((item): item is NonNullable<typeof item> =>
          item !== null && item.identity.groupId === groupId && matchesEntityFilter(item.entity, filter),
        );
        const selected = filtered.slice(offset, offset + limit);
        const body: Record<string, unknown> = {};
        for (const item of selected) body[item.identity.resourceId] = item.entity;

        const complete = scan.totalCount !== undefined && scan.totalCount <= MAX_DETAIL_FILTER_HYDRATIONS;
        setPagination(req, res, offset, limit, {
          ...(complete ? { totalCount: filtered.length } : {}),
          // Never invent a continuation beyond the hydrated snapshot.
          hasMore: offset + limit < filtered.length,
        });
        res.setHeader('X-Collection-Complete', String(complete));
        if (!complete) res.setHeader('Warning', '299 - "Filtered Hugging Face snapshot is incomplete"');
        setCacheMutable(res);
        res.json(body);
        return;
      }

      const scan = filter
        ? await client.listReposByOwner(type, groupId, { limit: MAX_DISCOVERY_ITEMS, skip: 0 }, undefined, true)
        : await client.listReposByOwner(type, groupId, { limit, skip: offset });

      let selected = [...scan.items];
      let totalCount = scan.totalCount;
      let hasMore = scan.hasMore;
      if (filter) {
        const filtered = selected.filter(item => {
          const identity = repoIdToIdentity(item.id);
          return identity.groupId === groupId && matchesEntityFilter(
            buildResourceDoc(getBaseUrl(req), type, identity.groupId, identity.resourceId, item, null, item.sha ? 1 : 0),
            filter,
          );
        });
        selected = filtered.slice(offset, offset + limit);
        totalCount = scan.totalCount === undefined ? undefined : filtered.length;
        hasMore = offset + limit < filtered.length;
      }

      const resolved = await Promise.all(selected.map(item =>
        buildExactResource(client, getBaseUrl(req), type, item.id),
      ));
      const body: Record<string, unknown> = {};
      for (const item of resolved) {
        if (!item || item.identity.groupId !== groupId || !matchesEntityFilter(item.entity, filter)) continue;
        body[item.identity.resourceId] = item.entity;
      }
      setPagination(req, res, offset, limit, {
        ...(totalCount === undefined ? {} : { totalCount }),
        hasMore,
      });
      res.setHeader('X-Collection-Complete', String(totalCount !== undefined));
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
    const requested = routeIdentity(req);
    if (!RESOURCE_TYPES.includes(rawType as ResourceType)) { res.status(404).json(problem(404, 'Resource type not found')); return; }
    if (!requested) { res.status(400).json(problem(400, 'Invalid repository identity', 'Group and resource entity IDs must not contain slashes.')); return; }
    const type = rawType as ResourceType;
    try {
      const resolved = await buildExactResource(client, getBaseUrl(req), type, requested.repoId);
      if (!resolved) { res.status(404).json(problem(404, 'Not found', `${requested.repoId} was not found`)); return; }
      if (resolved.identity.groupId !== requested.groupId || resolved.identity.resourceId !== requested.resourceId) {
        res.redirect(308, canonicalLocation(req, type, resolved.identity, '', true));
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
    const requested = routeIdentity(req);
    if (!RESOURCE_TYPES.includes(rawType as ResourceType)) { res.status(404).json(problem(404, 'Resource type not found')); return; }
    if (!requested) { res.status(400).json(problem(400, 'Invalid repository identity')); return; }
    const type = rawType as ResourceType;
    try {
      const resolved = await buildExactResource(client, getBaseUrl(req), type, requested.repoId);
      if (!resolved) { res.status(404).json(problem(404, 'Not found')); return; }
      if (resolved.identity.groupId !== requested.groupId || resolved.identity.resourceId !== requested.resourceId) {
        res.redirect(308, canonicalLocation(req, type, resolved.identity, '/meta', true));
        return;
      }
      setCacheMutable(res);
      res.json(buildMetaDoc(getBaseUrl(req), type, resolved));
    } catch (error) {
      console.error('[HF] get repository meta error', error);
      res.status(502).json(problem(502, 'Bad Gateway'));
    }
  });

  app.get(`/${GROUP_TYPE}/:groupId/:resourceType/:repoId/versions`, async (req: Request, res: Response) => {
    const rawType = rp(req, 'resourceType');
    const requested = routeIdentity(req);
    if (!RESOURCE_TYPES.includes(rawType as ResourceType)) { res.status(404).json(problem(404, 'Resource type not found')); return; }
    if (!requested) { res.status(400).json(problem(400, 'Invalid repository identity')); return; }
    const type = rawType as ResourceType;
    try {
      const canonical = await loadCanonicalRepo(client, type, requested.repoId);
      if (!canonical) { res.status(404).json(problem(404, 'Not found')); return; }
      if (canonical.identity.groupId !== requested.groupId || canonical.identity.resourceId !== requested.resourceId) {
        res.redirect(308, canonicalLocation(req, type, canonical.identity, '/versions', true));
        return;
      }
      if (rejectUnsupportedSort(req, res)) return;
      const limit = parseLimit(req);
      const offset = parseOffset(req);
      const snapshot = await materializeCommitSnapshot(client, type, canonical.info, canonical.identity.canonicalId);
      const selected = snapshot.items.slice(offset, offset + limit);
      const body = Object.fromEntries(selected.map(commit => [
        commit.id,
        buildVersionDoc(getBaseUrl(req), type, canonical.identity.groupId, canonical.identity.resourceId, commit, commit.id === canonical.info.sha),
      ]));
      setPagination(req, res, offset, limit, {
        ...(snapshot.complete ? { totalCount: snapshot.items.length } : {}),
        // A next relation is emitted only when the sorted snapshot contains a sentinel.
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
    const requested = routeIdentity(req);
    const sha = rp(req, 'sha');
    if (!RESOURCE_TYPES.includes(rawType as ResourceType)) { res.status(404).json(problem(404, 'Resource type not found')); return; }
    if (!requested) { res.status(400).json(problem(400, 'Invalid repository identity')); return; }
    if (!/^[0-9a-f]{4,64}$/i.test(sha)) { res.status(400).json(problem(400, 'Invalid version ID')); return; }
    const type = rawType as ResourceType;
    try {
      const canonical = await loadCanonicalRepo(client, type, requested.repoId);
      if (!canonical) { res.status(404).json(problem(404, 'Not found')); return; }
      if (canonical.identity.groupId !== requested.groupId || canonical.identity.resourceId !== requested.resourceId) {
        res.redirect(308, canonicalLocation(req, type, canonical.identity, `/versions/${encodeURIComponent(sha)}`, true));
        return;
      }
      const commit = await client.getCommitBySha(type, canonical.identity.canonicalId, sha)
        ?? (canonical.info.sha === sha ? repositoryShaCommit(canonical.info) : null);
      if (!commit) { res.status(404).json(problem(404, "Version not found")); return; }
      setCacheImmutable(res);
      res.json(buildVersionDoc(
        getBaseUrl(req), type, canonical.identity.groupId, canonical.identity.resourceId,
        commit, commit.id === canonical.info.sha,
      ));
    } catch (error) {
      console.error('[HF] get commit error', error);
      res.status(502).json(problem(502, 'Bad Gateway'));
    }
  });

}
