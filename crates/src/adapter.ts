import { HttpUpstreamClient, UpstreamError, type CacheLoadResult } from '@xregistry/registry-core';

export interface CratesIoUser {
  readonly id: number;
  readonly login: string;
  readonly name: string | null;
  readonly avatar: string | null;
  readonly url: string;
  readonly created_at?: string;
}

export interface CratesIoOwner extends CratesIoUser {
  readonly kind: string;
}

export interface CratesIoAuditAction {
  readonly action: string;
  readonly time: string;
  readonly user: CratesIoUser;
}

export interface CratesIoCrateLinks {
  readonly version_downloads: string | null;
  readonly versions: string | null;
  readonly owners: string | null;
  readonly owner_team: string | null;
  readonly owner_user: string | null;
  readonly reverse_dependencies: string | null;
}

/** Raw crates.io crate object from API v1 */
export interface CratesIoCrate {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly homepage: string | null;
  readonly repository: string | null;
  readonly documentation: string | null;
  readonly categories: readonly string[] | null;
  readonly keywords: readonly string[] | null;
  readonly downloads: number;
  readonly recent_downloads: number | null;
  readonly default_version: string | null;
  readonly max_version: string | null;
  readonly max_stable_version: string | null;
  readonly newest_version: string | null;
  readonly num_versions: number | null;
  readonly yanked: boolean | null;
  readonly trustpub_only: boolean | null;
  readonly links: CratesIoCrateLinks;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface CratesIoDependency {
  readonly name: string;
  readonly req: string;
  readonly features: readonly string[];
  readonly optional: boolean;
  readonly default_features: boolean;
  readonly target: string | null;
  readonly kind: string;
  readonly registry?: string | null;
  readonly package?: string | null;
}

/** Raw crates.io version object from API v1, augmented with sparse index data */
export interface CratesIoVersion {
  readonly id: number;
  readonly crate: string;
  readonly num: string;
  readonly dl_path: string;
  readonly readme_path: string | null;
  readonly updated_at: string;
  readonly created_at: string;
  readonly downloads: number;
  readonly features: Readonly<Record<string, readonly string[]>>;
  readonly features2?: Readonly<Record<string, readonly string[]>> | null;
  readonly v?: number | null;
  readonly yanked: boolean;
  readonly yank_message: string | null;
  readonly lib_links: string | null;
  readonly license: string | null;
  readonly links: Readonly<Record<string, string | null>>;
  readonly crate_size: number | null;
  readonly published_by: CratesIoUser | null;
  readonly audit_actions: readonly CratesIoAuditAction[];
  readonly checksum: string | null;
  readonly cksum?: string | null;
  readonly rust_version: string | null;
  readonly has_lib: boolean | null;
  readonly bin_names: readonly string[] | null;
  readonly edition: string | null;
  readonly description: string | null;
  readonly homepage: string | null;
  readonly documentation: string | null;
  readonly repository: string | null;
  readonly dependencies?: readonly CratesIoDependency[];
}

export interface CratesListResult {
  readonly crates: readonly CratesIoCrate[];
  readonly meta: {
    readonly total?: number;
    readonly next_page?: string | null;
    readonly prev_page?: string | null;
  };
}

export interface CratesGetResult {
  readonly crate: CratesIoCrate;
  readonly versions: readonly CratesIoVersion[];
  readonly owners: readonly CratesIoOwner[];
  readonly keywords: readonly { readonly crate_cnt: number; readonly created_at: string; readonly id: string }[];
  readonly categories: readonly { readonly crate_cnt: number; readonly created_at: string; readonly description: string; readonly id: string; readonly slug: string }[];
}

export interface CratesVersionsResult {
  readonly versions: readonly CratesIoVersion[];
  readonly meta: {
    readonly total?: number;
    readonly next_page?: string | null;
    readonly prev_page?: string | null;
  };
}

interface CratesOwnersResponse {
  readonly users: readonly CratesIoOwner[];
}

interface CratesIoIndexDependency {
  readonly name: string;
  readonly req: string;
  readonly features: readonly string[];
  readonly optional: boolean;
  readonly default_features: boolean;
  readonly target: string | null;
  readonly kind: string;
  readonly registry?: string | null;
  readonly package?: string | null;
}

interface CratesIoIndexEntry {
  readonly name: string;
  readonly vers: string;
  readonly deps: readonly CratesIoIndexDependency[];
  readonly cksum: string;
  readonly features: Readonly<Record<string, readonly string[]>>;
  readonly features2?: Readonly<Record<string, readonly string[]>>;
  readonly yanked: boolean;
  readonly rust_version?: string | null;
  readonly v?: number;
  readonly links?: string | null;
}

const USER_AGENT = 'xregistry-crates-proxy/1.0 (https://github.com/xregistry/xrproxy)';

function sparseIndexPath(crateName: string): string {
  const normalized = crateName.toLowerCase();
  if (normalized.length === 1) {
    return `1/${normalized}`;
  }
  if (normalized.length === 2) {
    return `2/${normalized}`;
  }
  if (normalized.length === 3) {
    return `3/${normalized[0]}/${normalized}`;
  }
  return `${normalized.slice(0, 2)}/${normalized.slice(2, 4)}/${normalized}`;
}

function parseSparseIndex(content: string): ReadonlyMap<string, CratesIoIndexEntry> {
  const entries = new Map<string, CratesIoIndexEntry>();
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const entry = JSON.parse(trimmed) as CratesIoIndexEntry;
    entries.set(entry.vers, entry);
  }
  return entries;
}

function mapIndexDependency(dep: CratesIoIndexDependency): CratesIoDependency {
  return {
    name: dep.name,
    req: dep.req,
    features: dep.features,
    optional: dep.optional,
    default_features: dep.default_features,
    target: dep.target,
    kind: dep.kind,
    ...(dep.registry !== undefined ? { registry: dep.registry } : {}),
    ...(dep.package !== undefined ? { package: dep.package } : {})
  };
}

function mergeVersion(version: CratesIoVersion, indexEntry: CratesIoIndexEntry | undefined): CratesIoVersion {
  if (!indexEntry) {
    return {
      ...version,
      ...(version.checksum !== null ? { cksum: version.checksum } : {})
    };
  }

  return {
    ...version,
    features: indexEntry.features,
    ...(indexEntry.features2 !== undefined ? { features2: indexEntry.features2 } : {}),
    ...(indexEntry.v !== undefined ? { v: indexEntry.v } : {}),
    yanked: indexEntry.yanked,
    lib_links: version.lib_links ?? indexEntry.links ?? null,
    cksum: indexEntry.cksum,
    rust_version: version.rust_version ?? indexEntry.rust_version ?? null,
    dependencies: indexEntry.deps.map(mapIndexDependency)
  };
}

export class CratesIoAdapter {
  private readonly client: HttpUpstreamClient;
  private readonly baseUrl: string;
  private readonly indexBaseUrl: string;

  constructor(options: {
    readonly baseUrl: string;
    readonly indexBaseUrl: string;
    readonly timeoutMs?: number;
    readonly operationTimeoutMs?: number;
    readonly maxAttempts?: number;
    readonly concurrency?: number;
    readonly fetch?: typeof globalThis.fetch;
  }) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.indexBaseUrl = options.indexBaseUrl.replace(/\/$/, '');
    this.client = new HttpUpstreamClient({
      timeoutMs: options.timeoutMs ?? 10_000,
      operationTimeoutMs: options.operationTimeoutMs ?? 30_000,
      maxAttempts: options.maxAttempts ?? 3,
      concurrency: options.concurrency ?? 16,
      ...(options.fetch ? { fetch: options.fetch } : {})
    });
  }

  private headers(accept = 'application/json'): Readonly<Record<string, string>> {
    return {
      'User-Agent': USER_AGENT,
      'Accept': accept
    };
  }

  private async getOwners(crateName: string): Promise<readonly CratesIoOwner[]> {
    const url = `${this.baseUrl}/api/v1/crates/${encodeURIComponent(crateName)}/owners`;
    try {
      const response = await this.client.request<CratesOwnersResponse>({
        url,
        headers: this.headers(),
        parse: async r => r.json() as Promise<CratesOwnersResponse>
      });
      return 'value' in response ? response.value.users : [];
    } catch (error) {
      if (error instanceof UpstreamError && error.code === 'not_found') {
        return [];
      }
      throw error;
    }
  }

  private async getSparseIndex(crateName: string): Promise<ReadonlyMap<string, CratesIoIndexEntry>> {
    const url = `${this.indexBaseUrl}/${sparseIndexPath(crateName)}`;
    try {
      const response = await this.client.request<string>({
        url,
        headers: this.headers('text/plain'),
        parse: async r => r.text()
      });
      return 'value' in response ? parseSparseIndex(response.value) : new Map<string, CratesIoIndexEntry>();
    } catch (error) {
      if (error instanceof UpstreamError && error.code === 'not_found') {
        return new Map<string, CratesIoIndexEntry>();
      }
      throw error;
    }
  }

  private async enrichCrate(result: CratesGetResult): Promise<CratesGetResult> {
    const [owners, indexEntries] = await Promise.all([
      this.getOwners(result.crate.name),
      this.getSparseIndex(result.crate.name)
    ]);

    return {
      ...result,
      owners,
      versions: result.versions.map(version => mergeVersion(version, indexEntries.get(version.num)))
    };
  }

  async listCrates(options: {
    readonly page?: number;
    readonly perPage?: number;
    readonly query?: string;
    readonly sort?: string;
    readonly etag?: string;
    readonly lastModified?: string;
  } = {}): Promise<CacheLoadResult<CratesListResult>> {
    const params = new URLSearchParams();
    if (options.page !== undefined) params.set('page', String(options.page));
    if (options.perPage !== undefined) params.set('per_page', String(options.perPage));
    if (options.query) params.set('q', options.query);
    if (options.sort) params.set('sort', options.sort);

    const url = `${this.baseUrl}/api/v1/crates?${params.toString()}`;
    const conditional = options.etag !== undefined || options.lastModified !== undefined
      ? {
          ...(options.etag !== undefined ? { etag: options.etag } : {}),
          ...(options.lastModified !== undefined ? { lastModified: options.lastModified } : {})
        }
      : undefined;

    const response = await this.client.request<CratesListResult>({
      url,
      headers: this.headers(),
      ...(conditional !== undefined ? { conditional } : {}),
      parse: async r => r.json() as Promise<CratesListResult>
    });

    if ('notModified' in response && response.notModified) {
      return {
        kind: 'not-modified',
        ...(response.etag !== undefined ? { etag: response.etag } : {}),
        ...(response.lastModified !== undefined ? { lastModified: response.lastModified } : {})
      };
    }

    if (!('value' in response)) {
      return { kind: 'not-found' };
    }

    return {
      kind: 'value',
      value: response.value,
      ...(response.etag !== undefined ? { etag: response.etag } : {}),
      ...(response.lastModified !== undefined ? { lastModified: response.lastModified } : {})
    };
  }

  async getCrate(name: string, options: {
    readonly etag?: string;
    readonly lastModified?: string;
  } = {}): Promise<CacheLoadResult<CratesGetResult>> {
    const url = `${this.baseUrl}/api/v1/crates/${encodeURIComponent(name)}`;
    const conditional = options.etag !== undefined || options.lastModified !== undefined
      ? {
          ...(options.etag !== undefined ? { etag: options.etag } : {}),
          ...(options.lastModified !== undefined ? { lastModified: options.lastModified } : {})
        }
      : undefined;

    try {
      const response = await this.client.request<CratesGetResult>({
        url,
        headers: this.headers(),
        ...(conditional !== undefined ? { conditional } : {}),
        parse: async r => r.json() as Promise<CratesGetResult>
      });

      if ('notModified' in response && response.notModified) {
        return {
          kind: 'not-modified',
          ...(response.etag !== undefined ? { etag: response.etag } : {}),
          ...(response.lastModified !== undefined ? { lastModified: response.lastModified } : {})
        };
      }

      if (!('value' in response)) {
        return { kind: 'not-found' };
      }

      const enriched = await this.enrichCrate(response.value);
      return {
        kind: 'value',
        value: enriched,
        ...(response.etag !== undefined ? { etag: response.etag } : {}),
        ...(response.lastModified !== undefined ? { lastModified: response.lastModified } : {})
      };
    } catch (error) {
      if (error instanceof UpstreamError && error.code === 'not_found') {
        return { kind: 'not-found' };
      }
      throw error;
    }
  }

  async getCrateVersions(name: string, options: {
    readonly page?: number;
    readonly perPage?: number;
    readonly etag?: string;
    readonly lastModified?: string;
  } = {}): Promise<CacheLoadResult<CratesVersionsResult>> {
    const result = await this.getCrate(name, {
      ...(options.etag !== undefined ? { etag: options.etag } : {}),
      ...(options.lastModified !== undefined ? { lastModified: options.lastModified } : {})
    });
    if (result.kind !== 'value') return result;

    const page = options.page ?? 1;
    const perPage = options.perPage ?? result.value.versions.length;
    const start = (page - 1) * perPage;
    return {
      kind: 'value',
      value: {
        versions: result.value.versions.slice(start, start + perPage),
        meta: { total: result.value.versions.length }
      },
      ...(result.etag !== undefined ? { etag: result.etag } : {}),
      ...(result.lastModified !== undefined ? { lastModified: result.lastModified } : {})
    };
  }
}
