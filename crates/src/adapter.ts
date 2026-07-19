import { HttpUpstreamClient, UpstreamError, type CacheLoadResult } from '@xregistry/registry-core';

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
  readonly max_version: string;
  readonly max_stable_version: string | null;
  readonly newest_version: string;
  readonly yanked: boolean | null;
  readonly license: string | null;
  readonly links: Readonly<Record<string, string | null>>;
  readonly created_at: string;
  readonly updated_at: string;
}

/** Raw crates.io version object from API v1 */
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
  readonly yanked: boolean;
  readonly license: string | null;
  readonly links: Readonly<Record<string, string | null>>;
  readonly crate_size: number | null;
  readonly published_by: {
    readonly id: number;
    readonly login: string;
    readonly name: string | null;
    readonly avatar: string | null;
    readonly url: string;
  } | null;
  readonly audit_actions: readonly unknown[];
}

/** Raw crates.io dependency object */
export interface CratesIoDependency {
  readonly id: number;
  readonly version_id: number;
  readonly crate_id: string;
  readonly req: string;
  readonly optional: boolean;
  readonly default_features: boolean;
  readonly features: readonly string[];
  readonly target: string | null;
  readonly kind: 'normal' | 'dev' | 'build';
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

export interface CratesDepsResult {
  readonly dependencies: readonly CratesIoDependency[];
  readonly version_id: string;
}

const USER_AGENT = 'xregistry-crates-proxy/1.0 (https://github.com/xregistry/xrproxy)';

export class CratesIoAdapter {
  private readonly client: HttpUpstreamClient;
  private readonly baseUrl: string;

  constructor(options: {
    readonly baseUrl: string;
    readonly timeoutMs?: number;
    readonly operationTimeoutMs?: number;
    readonly maxAttempts?: number;
    readonly concurrency?: number;
    readonly fetch?: typeof globalThis.fetch;
  }) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.client = new HttpUpstreamClient({
      timeoutMs: options.timeoutMs ?? 10_000,
      operationTimeoutMs: options.operationTimeoutMs ?? 30_000,
      maxAttempts: options.maxAttempts ?? 3,
      concurrency: options.concurrency ?? 16,
      ...(options.fetch ? { fetch: options.fetch } : {})
    });
  }

  private headers(): Readonly<Record<string, string>> {
    return {
      'User-Agent': USER_AGENT,
      'Accept': 'application/json'
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

      return {
        kind: 'value',
        value: response.value,
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

  async getCrateDependencies(name: string, version: string, options: {
    readonly etag?: string;
    readonly lastModified?: string;
  } = {}): Promise<CacheLoadResult<CratesDepsResult>> {
    const url = `${this.baseUrl}/api/v1/crates/${encodeURIComponent(name)}/${encodeURIComponent(version)}/dependencies`;
    const conditional = options.etag !== undefined || options.lastModified !== undefined
      ? {
          ...(options.etag !== undefined ? { etag: options.etag } : {}),
          ...(options.lastModified !== undefined ? { lastModified: options.lastModified } : {})
        }
      : undefined;

    try {
      const response = await this.client.request<CratesDepsResult>({
        url,
        headers: this.headers(),
        ...(conditional !== undefined ? { conditional } : {}),
        parse: async r => r.json() as Promise<CratesDepsResult>
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
    } catch (error) {
      if (error instanceof UpstreamError && error.code === 'not_found') {
        return { kind: 'not-found' };
      }
      throw error;
    }
  }
}
