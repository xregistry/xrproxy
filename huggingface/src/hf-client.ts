import {
  createCacheKey,
  FileSystemCacheStore,
  HttpUpstreamClient,
  MemoryCacheStore,
  TtlCache,
  UpstreamError,
  type CacheLoadResult,
  type CachePolicy,
  type CacheStore,
  type ConditionalRequest,
} from '@xregistry/registry-core';
import { repoIdToIdentity, UNNAMESPACED_GROUP_ID } from './repo-utils';

export type ResourceType = 'models' | 'datasets' | 'spaces';

export interface HfRepoListEntry {
  readonly id: string;
  readonly author?: string;
  readonly sha?: string;
  readonly lastModified?: string;
  readonly private?: boolean;
  readonly gated?: boolean | string;
  readonly downloads?: number;
  readonly likes?: number;
  readonly pipeline_tag?: string;
  readonly library_name?: string;
  readonly sdk?: string;
  readonly tags?: readonly string[];
}

export interface HfRepoInfo extends HfRepoListEntry {
  readonly modelId?: string;
  readonly cardData?: Record<string, unknown>;
  /** Default branch name from HF API (e.g. "main", "master"). */
  readonly gitalyDefaultBranch?: string;
}

export interface HfRefs {
  readonly branches: readonly HfRef[];
  readonly tags: readonly HfRef[];
  readonly converts?: readonly HfRef[];
}

export interface HfRef {
  readonly name: string;
  readonly ref?: string;
  readonly targetCommit: string;
}

export interface HfCommit {
  readonly id: string;
  readonly title?: string;
  readonly message?: string;
  readonly authors?: ReadonlyArray<{ readonly user?: string; readonly name?: string }>;
  readonly date?: string;
  readonly parents?: readonly string[];
}

export interface ListOptions {
  readonly limit?: number;
  readonly skip?: number;
  readonly search?: string;
  readonly author?: string;
}

export interface RepoPage {
  readonly items: readonly HfRepoListEntry[];
  readonly hasMore: boolean;
  /** Present only when the upstream scan reached the end and is authoritative. */
  readonly totalCount?: number;
}

export interface NamespaceRecord {
  readonly id: string;
  readonly counts: Readonly<Partial<Record<ResourceType, number>>>;
}

export interface NamespaceDiscovery {
  readonly namespaces: readonly NamespaceRecord[];
  readonly complete: boolean;
  readonly completeTypes: Readonly<Record<ResourceType, boolean>>;
}

const PREFIX_SCAN_PAGE_SIZE = 100;
export const MAX_FILTERED_SKIP = 500;
/** Maximum exact repository documents hydrated for one detail-field filter. */
export const MAX_DETAIL_FILTER_HYDRATIONS = 50;
export const PREFIX_SCAN_MAX_REQUESTS = 10;
export const MAX_DISCOVERY_ITEMS = PREFIX_SCAN_PAGE_SIZE * PREFIX_SCAN_MAX_REQUESTS;

export class PrefixSearchLimitError extends Error {
  constructor() {
    super(`Hugging Face prefix search exceeded the ${PREFIX_SCAN_MAX_REQUESTS}-request scan budget`);
    this.name = 'PrefixSearchLimitError';
  }
}

/** Encode an HF repo ID as path segments while preserving its namespace separator. */
export function encodeHubRepoPath(repoId: string): string {
  return repoId.split('/').map(segment => encodeURIComponent(segment)).join('/');
}

export function buildHubListUrl(
  baseUrl: string,
  type: ResourceType,
  opts: Required<Pick<ListOptions, 'limit' | 'skip'>> & Pick<ListOptions, 'search' | 'author'>,
): string {
  const params = new URLSearchParams({
    limit: String(opts.limit),
    skip: String(opts.skip),
  });
  if (opts.search !== undefined) params.set('search', opts.search);
  if (opts.author !== undefined) params.set('author', opts.author);
  return `${baseUrl.replace(/\/$/, '')}/api/${type}?${params.toString()}`;
}

/** Derive the default branch from repo info: gitalyDefaultBranch, or 'main'. */
export function defaultBranchOf(info: HfRepoInfo): string {
  return info.gitalyDefaultBranch ?? 'main';
}

export interface HuggingFaceClientOptions {
  readonly http: HttpUpstreamClient;
  readonly baseUrl: string;
  readonly mutableCacheStore?: CacheStore;
  readonly immutableCacheStore?: CacheStore;
  readonly mutableTtlMs?: number;
  readonly immutableTtlMs?: number;
}

/** Build a ConditionalRequest with only defined fields (safe for exactOptionalPropertyTypes). */
function conditional(etag?: string, lastModified?: string): ConditionalRequest {
  const r: Record<string, string> = {};
  if (etag !== undefined) r['etag'] = etag;
  if (lastModified !== undefined) r['lastModified'] = lastModified;
  return r as ConditionalRequest;
}

/** Build a positive CacheLoadResult. */
function hitResult<T>(value: T, etag?: string, lastModified?: string): CacheLoadResult<T> {
  return { kind: 'value', value, ...conditional(etag, lastModified) } as CacheLoadResult<T>;
}

/** Build a not-modified CacheLoadResult. */
function notModifiedResult<T>(etag?: string, lastModified?: string): CacheLoadResult<T> {
  return { kind: 'not-modified', ...conditional(etag, lastModified) } as CacheLoadResult<T>;
}

/** Build a not-found CacheLoadResult. */
function notFoundResult<T>(): CacheLoadResult<T> {
  return { kind: 'not-found' };
}

function optionalEnrichmentUnavailable(error: unknown): boolean {
  return error instanceof UpstreamError && (error.status === 401 || error.status === 403);
}

export interface CommitSnapshot {
  readonly items: readonly HfCommit[];
  readonly complete: boolean;
  readonly unavailable: boolean;
}

export const HUB_COMMIT_PAGE_SIZE = 50;
export const MAX_COMMIT_SNAPSHOT_PAGES = 10;

/**
 * Thin client for the public, anonymous Hugging Face Hub REST API.
 *
 * Cache policy:
 *   - Lists, repo info, refs  → mutableCache (short TTL, negative + stale-if-error)
 *   - Single commit by SHA    → immutableCache (1-yr TTL, stale-if-error = forever)
 *
 * This client NEVER sends any Authorization header and NEVER reads any
 * configured credentials.
 */
export class HuggingFaceClient {
  private readonly http: HttpUpstreamClient;
  private readonly baseUrl: string;
  private readonly mutableCache: TtlCache;
  private readonly immutableCache: TtlCache;

  constructor(options: HuggingFaceClientOptions) {
    this.http = options.http;
    this.baseUrl = options.baseUrl.replace(/\/$/, '');

    const mutablePolicy: CachePolicy = {
      ttlMs: options.mutableTtlMs ?? 300_000,
      negativeTtlMs: 30_000,
      staleIfErrorMs: 900_000,
    };
    const immutablePolicy: CachePolicy = {
      ttlMs: options.immutableTtlMs ?? 31_536_000_000,
      negativeTtlMs: 60_000,
      staleIfErrorMs: 31_536_000_000,
    };

    this.mutableCache = new TtlCache(
      options.mutableCacheStore ?? new MemoryCacheStore(),
      mutablePolicy,
    );
    this.immutableCache = new TtlCache(
      options.immutableCacheStore ?? new MemoryCacheStore(),
      immutablePolicy,
    );
  }

  /** Create a client backed by on-disk FileSystemCacheStore instances. */
  static withFileCache(
    http: HttpUpstreamClient,
    baseUrl: string,
    cacheDir: string,
    mutableTtlMs?: number,
    immutableTtlMs?: number,
  ): HuggingFaceClient {
    const base: HuggingFaceClientOptions = {
      http,
      baseUrl,
      mutableCacheStore: new FileSystemCacheStore(`${cacheDir}/mutable`),
      immutableCacheStore: new FileSystemCacheStore(`${cacheDir}/immutable`),
    };
    const overrides: Partial<HuggingFaceClientOptions> = {};
    if (mutableTtlMs !== undefined) (overrides as Record<string, unknown>)['mutableTtlMs'] = mutableTtlMs;
    if (immutableTtlMs !== undefined) (overrides as Record<string, unknown>)['immutableTtlMs'] = immutableTtlMs;
    return new HuggingFaceClient({ ...base, ...overrides } as HuggingFaceClientOptions);
  }

  async listRepos(type: ResourceType, opts: ListOptions = {}): Promise<readonly HfRepoListEntry[]> {
    const limit = opts.limit ?? 20;
    const skip = opts.skip ?? 0;
    const url = buildHubListUrl(this.baseUrl, type, {
      limit,
      skip,
      ...(opts.search !== undefined ? { search: opts.search } : {}),
      ...(opts.author !== undefined ? { author: opts.author } : {}),
    });
    const key = createCacheKey('list', type, limit, skip, opts.search ?? '', opts.author ?? '');

    const result = await this.mutableCache.get<HfRepoListEntry[]>(key, async ctx => {
      const res = await this.http.getJson<HfRepoListEntry[]>(url, {
        conditional: conditional(ctx.etag, ctx.lastModified),
      });
      if ('notModified' in res) return notModifiedResult<HfRepoListEntry[]>(res.etag, res.lastModified);
      return hitResult(res.value, res.etag, res.lastModified);
    });

    return result.kind === 'value' ? (result.value ?? []) : [];
  }

  private async scanMatchingRepos(
    type: ResourceType,
    search: string | undefined,
    predicate: (repo: HfRepoListEntry) => boolean,
    opts: ListOptions,
    countAll = false,
  ): Promise<RepoPage> {
    const limit = opts.limit ?? 20;
    const skip = opts.skip ?? 0;
    const needed = skip + limit + 1;
    const matches: HfRepoListEntry[] = [];
    const seenRepoIds = new Set<string>();
    let upstreamSkip = 0;
    let requests = 0;
    let exhausted = false;

    while ((countAll || matches.length < needed) && requests < PREFIX_SCAN_MAX_REQUESTS) {
      const page = await this.listRepos(type, {
        limit: PREFIX_SCAN_PAGE_SIZE,
        skip: upstreamSkip,
        ...(search !== undefined ? { search } : {}),
        ...(opts.author !== undefined ? { author: opts.author } : {}),
      });
      requests += 1;
      let newRepoCount = 0;
      for (const repo of page) {
        const normalizedId = repo.id.toLowerCase();
        if (seenRepoIds.has(normalizedId)) continue;
        seenRepoIds.add(normalizedId);
        newRepoCount += 1;
        if (predicate(repo)) matches.push(repo);
      }
      if (page.length < PREFIX_SCAN_PAGE_SIZE || newRepoCount === 0) {
        exhausted = true;
        break;
      }
      upstreamSkip += page.length;
    }

    // Only advertise a continuation when the bounded snapshot contains an
    // actual sentinel item. An incomplete scan is not itself a resumable
    // cursor; claiming otherwise creates an infinite chain of empty pages.
    return {
      items: matches.slice(skip, skip + limit),
      hasMore: matches.length > skip + limit,
      ...(exhausted ? { totalCount: matches.length } : {}),
    };
  }

  /** Exact prefix filtering over the Hub's broader search endpoint. */
  async listReposByPrefix(type: ResourceType, prefix: string, opts: ListOptions = {}): Promise<RepoPage> {
    const normalizedPrefix = prefix.toLowerCase();
    return this.scanMatchingRepos(
      type,
      prefix,
      repo => repo.id.toLowerCase().startsWith(normalizedPrefix),
      opts,
    );
  }

  /** List resources belonging to one native owner namespace. */
  async listReposByOwner(
    type: ResourceType,
    groupId: string,
    opts: ListOptions = {},
    namePrefix?: string,
    countAll = false,
  ): Promise<RepoPage> {
    const owner = groupId === UNNAMESPACED_GROUP_ID ? undefined : groupId;
    const normalizedPrefix = namePrefix?.toLowerCase();
    return this.scanMatchingRepos(
      type,
      normalizedPrefix,
      repo => {
        try {
          const identity = repoIdToIdentity(repo.id);
          const canonical = repo.id.toLowerCase();
          const basename = identity.resourceId.toLowerCase();
          return identity.groupId === groupId &&
            (normalizedPrefix === undefined || canonical.startsWith(normalizedPrefix) || basename.startsWith(normalizedPrefix));
        } catch {
          return false;
        }
      },
      { ...opts, ...(owner === undefined ? {} : { author: owner }) },
      countAll,
    );
  }

  /**
   * Discover namespace groups from bounded scans of each independent Hub
   * collection. `complete=false` means global counts are intentionally omitted.
   */
  async discoverNamespaces(): Promise<NamespaceDiscovery> {
    const counts = new Map<string, Partial<Record<ResourceType, number>>>();
    const completeTypes: Record<ResourceType, boolean> = {
      models: false,
      datasets: false,
      spaces: false,
    };

    for (const type of ['models', 'datasets', 'spaces'] as const) {
      const seen = new Set<string>();
      for (let request = 0; request < PREFIX_SCAN_MAX_REQUESTS; request += 1) {
        const page = await this.listRepos(type, {
          limit: PREFIX_SCAN_PAGE_SIZE,
          skip: request * PREFIX_SCAN_PAGE_SIZE,
        });
        let added = 0;
        for (const repo of page) {
          const canonicalKey = repo.id.toLowerCase();
          if (seen.has(canonicalKey)) continue;
          seen.add(canonicalKey);
          added += 1;
          try {
            const { groupId } = repoIdToIdentity(repo.id);
            const current = counts.get(groupId) ?? {};
            current[type] = (current[type] ?? 0) + 1;
            counts.set(groupId, current);
          } catch {
            // Ignore malformed upstream IDs rather than exposing invalid entities.
          }
        }
        if (page.length < PREFIX_SCAN_PAGE_SIZE || added === 0) {
          completeTypes[type] = true;
          break;
        }
      }
    }

    return {
      namespaces: [...counts.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([id, namespaceCounts]) => ({ id, counts: namespaceCounts })),
      complete: Object.values(completeTypes).every(Boolean),
      completeTypes,
    };
  }

  async getRepo(type: ResourceType, repoId: string): Promise<HfRepoInfo | null> {
    const url = `${this.baseUrl}/api/${type}/${encodeHubRepoPath(repoId)}`;
    const key = createCacheKey('repo', type, repoId);

    const result = await this.mutableCache.get<HfRepoInfo>(key, async ctx => {
      try {
        const res = await this.http.getJson<HfRepoInfo>(url, {
          conditional: conditional(ctx.etag, ctx.lastModified),
        });
        if ('notModified' in res) return notModifiedResult<HfRepoInfo>(res.etag, res.lastModified);
        return hitResult(res.value, res.etag, res.lastModified);
      } catch (err) {
        if (err instanceof UpstreamError && err.code === 'not_found') return notFoundResult<HfRepoInfo>();
        throw err;
      }
    });

    return result.kind === 'value' ? (result.value ?? null) : null;
  }

  async getRefs(type: ResourceType, repoId: string): Promise<HfRefs | null> {
    const url = `${this.baseUrl}/api/${type}/${encodeHubRepoPath(repoId)}/refs`;
    const key = createCacheKey('refs', type, repoId);

    const result = await this.mutableCache.get<HfRefs>(key, async ctx => {
      try {
        const res = await this.http.getJson<HfRefs>(url, {
          conditional: conditional(ctx.etag, ctx.lastModified),
        });
        if ('notModified' in res) return notModifiedResult<HfRefs>(res.etag, res.lastModified);
        return hitResult(res.value, res.etag, res.lastModified);
      } catch (err) {
        if (err instanceof UpstreamError && err.code === 'not_found') return notFoundResult<HfRefs>();
        if (optionalEnrichmentUnavailable(err)) return notFoundResult<HfRefs>();
        throw err;
      }
    });

    return result.kind === 'value' ? (result.value ?? null) : null;
  }

  /**
   * List commits for a ref (branch name or SHA).
   * Always passes the repo's actual default branch (from gitalyDefaultBranch),
   * never hardcoded 'main'.
   */
  async listCommits(
    type: ResourceType,
    repoId: string,
    ref: string,
    page = 0,
  ): Promise<readonly HfCommit[]> {
    const url = `${this.baseUrl}/api/${type}/${encodeHubRepoPath(repoId)}/commits/${encodeURIComponent(ref)}?p=${page}`;
    const key = createCacheKey('commits', type, repoId, ref, page);

    const result = await this.mutableCache.get<HfCommit[]>(key, async ctx => {
      try {
        const res = await this.http.getJson<HfCommit[]>(url, {
          conditional: conditional(ctx.etag, ctx.lastModified),
        });
        if ('notModified' in res) return notModifiedResult<HfCommit[]>(res.etag, res.lastModified);
        return hitResult(res.value, res.etag, res.lastModified);
      } catch (err) {
        if (err instanceof UpstreamError && err.code === 'not_found') return notFoundResult<HfCommit[]>();
        if (optionalEnrichmentUnavailable(err)) return notFoundResult<HfCommit[]>();
        throw err;
      }
    });

    return result.kind === 'value' ? (result.value ?? []) : [];
  }

  /** Materialize one bounded, ID-sorted commit snapshot for stable xRegistry pagination. */
  async getCommitSnapshot(type: ResourceType, repoId: string, ref: string): Promise<CommitSnapshot> {
    const commits = new Map<string, HfCommit>();
    let complete = false;
    let unavailable = false;
    for (let page = 0; page < MAX_COMMIT_SNAPSHOT_PAGES; page += 1) {
      const items = await this.listCommits(type, repoId, ref, page);
      const before = commits.size;
      for (const commit of items) commits.set(commit.id, commit);
      if (items.length === 0 && page === 0) unavailable = true;
      if (items.length < HUB_COMMIT_PAGE_SIZE || commits.size === before) {
        complete = true;
        break;
      }
    }
    return {
      items: [...commits.values()].sort((a, b) =>
        a.id.localeCompare(b.id, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id),
      ),
      complete,
      unavailable,
    };
  }

  /**
   * Fetch a **single, specific commit by its full SHA** via the HF commits
   * endpoint using the SHA as the ref argument.
   *
   * The HF API resolves a full commit SHA the same way it resolves a branch
   * name; the response contains that exact commit as the first entry.
   *
   * This is the correct, authoritative lookup path — it does NOT scan page 1
   * of the default-branch history and therefore works for any commit regardless
   * of its position in the history.
   *
   * Stored in the **immutable** cache (1-yr TTL, stale-if-error = forever)
   * because commit SHAs are content-addressed and never change.
   */
  async getCommitBySha(
    type: ResourceType,
    repoId: string,
    sha: string,
  ): Promise<HfCommit | null> {
    const key = createCacheKey('commit-sha', type, repoId, sha);

    const result = await this.immutableCache.get<HfCommit>(key, async () => {
      const url = `${this.baseUrl}/api/${type}/${encodeHubRepoPath(repoId)}/commits/${encodeURIComponent(sha)}`;
      try {
        const res = await this.http.getJson<HfCommit[]>(url);
        if ('notModified' in res) return notModifiedResult<HfCommit>();
        const commits = res.value ?? [];
        const commit = commits.find(c => c.id === sha || c.id.startsWith(sha));
        if (!commit) return notFoundResult<HfCommit>();
        return hitResult(commit);
      } catch (err) {
        if (err instanceof UpstreamError && err.code === 'not_found') return notFoundResult<HfCommit>();
        if (optionalEnrichmentUnavailable(err)) return notFoundResult<HfCommit>();
        throw err;
      }
    });

    return result.kind === 'value' ? (result.value ?? null) : null;
  }
}
