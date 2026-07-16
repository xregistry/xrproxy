import type { Express, Request, Response } from 'express';
import type { HfConfig } from '../config';
import type { HuggingFaceClient } from '../hf-client';
import type { ResourceType } from '../hf-client';
import { decodeRepoId, encodeRepoId, isValidEncodedRepoId } from '../repo-utils';
import { defaultBranchOf } from '../hf-client';

const SPEC_VERSION = '1.0-rc2';
const REGISTRY_ID = 'huggingface-hub';
const REGISTRY_NAME = 'Hugging Face Hub xRegistry';
const GROUP_TYPE = 'huggingfaceregistries';
const GROUP_SINGULAR = 'huggingfaceregistry';
const GROUP_ID = 'huggingface.co';
const RESOURCE_TYPES: readonly ResourceType[] = ['models', 'datasets', 'spaces'];
const RESOURCE_SINGULARS: Record<ResourceType, string> = {
  models: 'model',
  datasets: 'dataset',
  spaces: 'space',
};

/** Startup timestamp used for createdat/modifiedat on synthetic entities. */
const STARTUP_TIME = new Date().toISOString();

/** RFC 9457 problem details body. */
function problem(status: number, title: string, detail?: string, instance?: string): Record<string, unknown> {
  return {
    type: 'about:blank',
    title,
    status,
    ...(detail ? { detail } : {}),
    ...(instance ? { instance } : {}),
  };
}

/** Derive the external base URL from proxy/forwarding headers. */
function getBaseUrl(req: Request): string {
  const xBase = req.get('x-base-url');
  if (xBase) return xBase;
  if (process.env['BASE_URL']) return process.env['BASE_URL'];
  const proto = req.get('x-forwarded-proto') ?? req.protocol ?? 'http';
  const host = req.get('x-forwarded-host') ?? req.get('host');
  return host ? `${proto}://${host}` : `${proto}://localhost`;
}

/** Set Cache-Control for mutable resources (short TTL). */
function setCacheMutable(res: Response, ttlSec = 300): void {
  res.setHeader('Cache-Control', `public, max-age=${ttlSec}, s-maxage=${ttlSec}, stale-while-revalidate=60`);
}

/** Set Cache-Control for immutable commit-SHA versions (1-year). */
function setCacheImmutable(res: Response): void {
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
}

/** Build the xID path for a resource. */
function resourcePath(type: ResourceType, encodedId: string): string {
  return `/${GROUP_TYPE}/${GROUP_ID}/${type}/${encodedId}`;
}

/** Build the xID path for a version within a resource. */
function versionPath(type: ResourceType, encodedId: string, sha: string): string {
  return `${resourcePath(type, encodedId)}/versions/${sha}`;
}

/** Build a resource document from HF API data. */
function buildResourceDoc(
  base: string,
  type: ResourceType,
  encodedId: string,
  repoInfo: {
    id: string;
    author?: string;
    sha?: string;
    lastModified?: string;
    private?: boolean;
    gated?: boolean | string;
    downloads?: number;
    likes?: number;
    pipeline_tag?: string;
    library_name?: string;
    sdk?: string;
    tags?: readonly string[];
  },
  refs: { branches: readonly { name: string; targetCommit: string }[]; tags: readonly { name: string; targetCommit: string }[] } | null,
): Record<string, unknown> {
  const singular = RESOURCE_SINGULARS[type];
  const repoId = decodeRepoId(encodedId);
  const rPath = resourcePath(type, encodedId);

  const doc: Record<string, unknown> = {
    [`${singular}id`]: encodedId,
    xid: rPath,
    self: `${base}${rPath}`,
    name: repoId,
    epoch: 1,
    createdat: repoInfo.lastModified ?? STARTUP_TIME,
    modifiedat: repoInfo.lastModified ?? STARTUP_TIME,
    // Current default version = HEAD commit SHA
    versionid: repoInfo.sha ?? 'unknown',
    isdefault: true,
    metaurl: `${base}${rPath}/meta`,
    versionsurl: `${base}${rPath}/versions`,
    // versionscount omitted – HF does not expose an authoritative total
    repoid: repoId,
    author: repoInfo.author ?? null,
    sha: repoInfo.sha ?? null,
    private: repoInfo.private ?? false,
    gated: repoInfo.gated ?? false,
    downloads: repoInfo.downloads ?? 0,
    likes: repoInfo.likes ?? 0,
    tags: repoInfo.tags ?? [],
    refs: refs
      ? {
          branches: refs.branches.map(b => ({ name: b.name, targetCommit: b.targetCommit })),
          tags: refs.tags.map(t => ({ name: t.name, targetCommit: t.targetCommit })),
        }
      : null,
  };

  if (type === 'models') {
    doc['pipeline_tag'] = (repoInfo as { pipeline_tag?: string }).pipeline_tag ?? null;
    doc['library_name'] = (repoInfo as { library_name?: string }).library_name ?? null;
  }
  if (type === 'spaces') {
    doc['sdk'] = (repoInfo as { sdk?: string }).sdk ?? null;
  }

  return doc;
}

/** Build a version document from a HF commit. */
function buildVersionDoc(
  base: string,
  type: ResourceType,
  encodedId: string,
  commit: { id: string; title?: string; message?: string; date?: string; authors?: ReadonlyArray<{ user?: string; name?: string }> },
  isDefault: boolean,
): Record<string, unknown> {
  const singular = RESOURCE_SINGULARS[type];
  const vPath = versionPath(type, encodedId, commit.id);
  const rPath = resourcePath(type, encodedId);

  return {
    versionid: commit.id,
    xid: vPath,
    self: `${base}${vPath}`,
    [`${singular}id`]: encodedId,
    epoch: 1,
    createdat: commit.date ?? STARTUP_TIME,
    modifiedat: commit.date ?? STARTUP_TIME,
    isdefault: isDefault,
    sha: commit.id,
    message: commit.title ?? commit.message ?? '',
    author: commit.authors?.[0]?.user ?? commit.authors?.[0]?.name ?? null,
    resourceurl: `${base}${rPath}`,
  };
}

/** Extract a named route param as a plain string (Express v5 strict typing). */
function rp(req: Request, name: string): string {
  const v = req.params[name];
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}

export function setupRoutes(app: Express, _config: HfConfig, client: HuggingFaceClient): void {
  // ─── Registry root ────────────────────────────────────────────────────────
  app.get('/', (req: Request, res: Response) => {
    const base = getBaseUrl(req);
    setCacheMutable(res);
    res.setHeader('Content-Type', 'application/json');
    res.json({
      specversion: SPEC_VERSION,
      registryid: REGISTRY_ID,
      xid: '/',
      name: REGISTRY_NAME,
      self: `${base}/`,
      description:
        'xRegistry-compliant Hugging Face Hub registry. Anonymous access only. ' +
        'Models, datasets, and spaces. Immutable versions are commit SHAs; ' +
        'branches and tags are mutable aliases embedded in the refs attribute.',
      epoch: 1,
      createdat: STARTUP_TIME,
      modifiedat: STARTUP_TIME,
      modelurl: `${base}/model`,
      capabilitiesurl: `${base}/capabilities`,
      [`${GROUP_TYPE}url`]: `${base}/${GROUP_TYPE}`,
      [`${GROUP_TYPE}count`]: 1,
    });
  });

  // ─── Group collection ─────────────────────────────────────────────────────
  app.get(`/${GROUP_TYPE}`, (req: Request, res: Response) => {
    const base = getBaseUrl(req);
    const groupPath = `/${GROUP_TYPE}/${GROUP_ID}`;
    setCacheMutable(res);
    res.json({
      [GROUP_ID]: {
        [`${GROUP_SINGULAR}id`]: GROUP_ID,
        xid: groupPath,
        self: `${base}${groupPath}`,
        epoch: 1,
        createdat: STARTUP_TIME,
        modifiedat: STARTUP_TIME,
        ...Object.fromEntries(
          RESOURCE_TYPES.map(t => [`${t}url`, `${base}${groupPath}/${t}`]),
        ),
      },
    });
  });

  // ─── Specific group ────────────────────────────────────────────────────────
  app.get(`/${GROUP_TYPE}/:registryId`, (req: Request, res: Response) => {
    const registryId = rp(req, 'registryId');
    if (registryId !== GROUP_ID) {
      res.status(404).json(problem(404, 'Registry not found', `Registry '${registryId}' does not exist`));
      return;
    }
    const base = getBaseUrl(req);
    const groupPath = `/${GROUP_TYPE}/${GROUP_ID}`;
    setCacheMutable(res);
    res.json({
      [`${GROUP_SINGULAR}id`]: GROUP_ID,
      xid: groupPath,
      self: `${base}${groupPath}`,
      epoch: 1,
      createdat: STARTUP_TIME,
      modifiedat: STARTUP_TIME,
      ...Object.fromEntries(
        RESOURCE_TYPES.map(t => [`${t}url`, `${base}${groupPath}/${t}`]),
      ),
    });
  });

  // ─── Resource collection (models / datasets / spaces) ─────────────────────
  app.get(`/${GROUP_TYPE}/:registryId/:resourceType`, async (req: Request, res: Response) => {
    const registryId = rp(req, 'registryId');
    const resourceType = rp(req, 'resourceType');
    if (registryId !== GROUP_ID) {
      res.status(404).json(problem(404, 'Registry not found'));
      return;
    }
    if (!RESOURCE_TYPES.includes(resourceType as ResourceType)) {
      res.status(404).json(problem(404, 'Resource type not found', `Unknown resource type '${resourceType}'`));
      return;
    }
    const type = resourceType as ResourceType;
    const limit = Math.min(parseInt((req.query['limit'] as string | undefined) ?? '20', 10) || 20, 100);
    const skip = parseInt((req.query['skip'] as string | undefined) ?? '0', 10) || 0;
    const base = getBaseUrl(req);

    try {
      const items = await client.listRepos(type, { limit, skip });
      const collection: Record<string, unknown> = {};
      for (const item of items) {
        const encoded = encodeRepoId(item.id);
        const rPath = resourcePath(type, encoded);
        const singular = RESOURCE_SINGULARS[type];
        collection[encoded] = {
          [`${singular}id`]: encoded,
          xid: rPath,
          self: `${base}${rPath}`,
          name: item.id,
          epoch: 1,
          createdat: item.lastModified ?? STARTUP_TIME,
          modifiedat: item.lastModified ?? STARTUP_TIME,
          versionid: item.sha ?? 'unknown',
          versionsurl: `${base}${rPath}/versions`,
          repoid: item.id,
          author: item.author ?? null,
          sha: item.sha ?? null,
          private: item.private ?? false,
          gated: item.gated ?? false,
        };
      }

      // Pagination Link header
      if (items.length >= limit) {
        const nextSkip = skip + limit;
        const nextUrl = `${base}/${GROUP_TYPE}/${GROUP_ID}/${type}?limit=${limit}&skip=${nextSkip}`;
        res.setHeader('Link', `<${nextUrl}>; rel="next"`);
      }

      setCacheMutable(res);
      res.json(collection);
    } catch (err) {
      console.error('[HF] listRepos error', err);
      res.status(502).json(problem(502, 'Bad Gateway', 'Failed to reach Hugging Face Hub API'));
    }
  });

  // ─── Single resource ───────────────────────────────────────────────────────
  app.get(`/${GROUP_TYPE}/:registryId/:resourceType/:repoId`, async (req: Request, res: Response) => {
    const registryId = rp(req, 'registryId');
    const resourceType = rp(req, 'resourceType');
    const encodedId = rp(req, 'repoId');
    if (registryId !== GROUP_ID) {
      res.status(404).json(problem(404, 'Registry not found'));
      return;
    }
    if (!RESOURCE_TYPES.includes(resourceType as ResourceType)) {
      res.status(404).json(problem(404, 'Resource type not found'));
      return;
    }
    if (!isValidEncodedRepoId(encodedId)) {
      res.status(400).json(problem(400, 'Invalid repo ID', `'${encodedId}' is not a valid encoded repo ID`));
      return;
    }
    const type = resourceType as ResourceType;
    const repoId = decodeRepoId(encodedId);
    const base = getBaseUrl(req);

    try {
      const [info, refs] = await Promise.all([
        client.getRepo(type, repoId),
        client.getRefs(type, repoId),
      ]);
      if (!info) {
        res.status(404).json(problem(404, 'Not found', `${type.slice(0, -1)} '${repoId}' was not found`));
        return;
      }
      setCacheMutable(res);
      res.json(buildResourceDoc(base, type, encodedId, info, refs));
    } catch (err) {
      console.error('[HF] getRepo error', err);
      res.status(502).json(problem(502, 'Bad Gateway', 'Failed to reach Hugging Face Hub API'));
    }
  });

  // ─── Resource meta ─────────────────────────────────────────────────────────
  app.get(`/${GROUP_TYPE}/:registryId/:resourceType/:repoId/meta`, async (req: Request, res: Response) => {
    const registryId = rp(req, 'registryId');
    const resourceType = rp(req, 'resourceType');
    const encodedId = rp(req, 'repoId');
    if (registryId !== GROUP_ID) { res.status(404).json(problem(404, 'Registry not found')); return; }
    if (!RESOURCE_TYPES.includes(resourceType as ResourceType)) { res.status(404).json(problem(404, 'Resource type not found')); return; }
    if (!isValidEncodedRepoId(encodedId)) { res.status(400).json(problem(400, 'Invalid repo ID')); return; }
    const type = resourceType as ResourceType;
    const repoId = decodeRepoId(encodedId);
    const base = getBaseUrl(req);

    try {
      const info = await client.getRepo(type, repoId);
      if (!info) { res.status(404).json(problem(404, 'Not found')); return; }
      const singular = RESOURCE_SINGULARS[type];
      const rPath = resourcePath(type, encodedId);
      setCacheMutable(res);
      res.json({
        [`${singular}id`]: encodedId,
        xid: rPath,
        self: `${base}${rPath}`,
        epoch: 1,
        createdat: info.lastModified ?? STARTUP_TIME,
        modifiedat: info.lastModified ?? STARTUP_TIME,
        versionid: info.sha ?? 'unknown',
        isdefault: true,
        metaurl: `${base}${rPath}/meta`,
        versionsurl: `${base}${rPath}/versions`,
      });
    } catch (err) {
      res.status(502).json(problem(502, 'Bad Gateway'));
    }
  });

  // ─── Version collection (commits) ─────────────────────────────────────────
  app.get(`/${GROUP_TYPE}/:registryId/:resourceType/:repoId/versions`, async (req: Request, res: Response) => {
    const registryId = rp(req, 'registryId');
    const resourceType = rp(req, 'resourceType');
    const encodedId = rp(req, 'repoId');
    if (registryId !== GROUP_ID) { res.status(404).json(problem(404, 'Registry not found')); return; }
    if (!RESOURCE_TYPES.includes(resourceType as ResourceType)) { res.status(404).json(problem(404, 'Resource type not found')); return; }
    if (!isValidEncodedRepoId(encodedId)) { res.status(400).json(problem(400, 'Invalid repo ID')); return; }
    const type = resourceType as ResourceType;
    const repoId = decodeRepoId(encodedId);
    const page = parseInt((req.query['page'] as string | undefined) ?? '1', 10) || 1;
    const base = getBaseUrl(req);

    try {
      const info = await client.getRepo(type, repoId);
      if (!info) { res.status(404).json(problem(404, 'Not found')); return; }

      // Use the repo's actual default branch, not hardcoded 'main'
      const branch = defaultBranchOf(info);
      const commits = await client.listCommits(type, repoId, branch, page);

      const headSha = info.sha;
      const collection: Record<string, unknown> = {};
      for (const commit of commits) {
        collection[commit.id] = buildVersionDoc(base, type, encodedId, commit, commit.id === headSha);
      }

      if (commits.length > 0) {
        const nextPage = page + 1;
        const nextUrl = `${base}/${GROUP_TYPE}/${GROUP_ID}/${type}/${encodedId}/versions?page=${nextPage}`;
        res.setHeader('Link', `<${nextUrl}>; rel="next"`);
      }

      // Version list is mutable (new commits can appear)
      setCacheMutable(res, 60);
      res.json(collection);
    } catch (err) {
      console.error('[HF] listCommits error', err);
      res.status(502).json(problem(502, 'Bad Gateway'));
    }
  });

  // ─── Single version (commit SHA) ──────────────────────────────────────────
  app.get(`/${GROUP_TYPE}/:registryId/:resourceType/:repoId/versions/:sha`, async (req: Request, res: Response) => {
    const registryId = rp(req, 'registryId');
    const resourceType = rp(req, 'resourceType');
    const encodedId = rp(req, 'repoId');
    const sha = rp(req, 'sha');
    if (registryId !== GROUP_ID) { res.status(404).json(problem(404, 'Registry not found')); return; }
    if (!RESOURCE_TYPES.includes(resourceType as ResourceType)) { res.status(404).json(problem(404, 'Resource type not found')); return; }
    if (!isValidEncodedRepoId(encodedId)) { res.status(400).json(problem(400, 'Invalid repo ID')); return; }
    if (!/^[0-9a-f]{4,64}$/i.test(sha)) {
      res.status(400).json(problem(400, 'Invalid version ID', `'${sha}' does not look like a commit SHA`));
      return;
    }
    const type = resourceType as ResourceType;
    const repoId = decodeRepoId(encodedId);
    const base = getBaseUrl(req);

    try {
      const info = await client.getRepo(type, repoId);
      if (!info) { res.status(404).json(problem(404, 'Not found')); return; }

      // Direct commit lookup by SHA – no page-scan.
      // getCommitBySha passes the SHA as a ref to the HF commits endpoint,
      // which resolves it to that exact commit. Result is immutably cached.
      const commit = await client.getCommitBySha(type, repoId, sha);
      if (!commit) {
        res.status(404).json(problem(404, 'Version not found', `Commit '${sha}' was not found`));
        return;
      }

      // Commit SHAs are immutable – long cache
      setCacheImmutable(res);
      res.json(buildVersionDoc(base, type, encodedId, commit, commit.id === info.sha));
    } catch (err) {
      console.error('[HF] getVersion error', err);
      res.status(502).json(problem(502, 'Bad Gateway'));
    }
  });
}
