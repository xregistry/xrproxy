import {
    CacheLoadResult,
    ConditionalHttpResponse,
    HttpUpstreamClient,
    TtlCache,
    FileSystemCacheStore,
    MemoryCacheStore,
    createCacheKey,
} from '@xregistry/registry-core';
import { CACHE_CONFIG, RUBYGEMS_API } from '../config/constants';
import { RubyGemMetadata, RubyGemVersion } from '../types/xregistry';

const COMMON_HEADERS: Readonly<Record<string, string>> = {
    'User-Agent': RUBYGEMS_API.USER_AGENT,
    Accept: 'application/json',
};

export interface RubyGemsServiceOptions {
    /** Directory for persistent disk cache. Defaults to CACHE_CONFIG.CACHE_DIR. */
    readonly cacheDir?: string;
    /** Base URL for the RubyGems API. Defaults to RUBYGEMS_API.BASE_URL. */
    readonly baseUrl?: string;
    /** Inject a custom fetch implementation (useful in tests). */
    readonly fetch?: typeof globalThis.fetch;
}

function toLoadResult<T>(res: ConditionalHttpResponse<T>): CacheLoadResult<T> {
    if ('notModified' in res) {
        return {
            kind: 'not-modified',
            ...(res.etag !== undefined ? { etag: res.etag } : {}),
            ...(res.lastModified !== undefined ? { lastModified: res.lastModified } : {}),
        };
    }
    return {
        kind: 'value',
        value: res.value,
        ...(res.etag !== undefined ? { etag: res.etag } : {}),
        ...(res.lastModified !== undefined ? { lastModified: res.lastModified } : {}),
    };
}

export class RubyGemsService {
    private readonly client: HttpUpstreamClient;
    private readonly baseUrl: string;
    private readonly gemCache: TtlCache;
    private readonly versionsCache: TtlCache;
    private readonly searchCache: TtlCache;

    constructor(options: RubyGemsServiceOptions = {}) {
        this.baseUrl = (options.baseUrl ?? RUBYGEMS_API.BASE_URL).replace(/\/$/, '');

        this.client = new HttpUpstreamClient({
            timeoutMs: CACHE_CONFIG.HTTP_TIMEOUT_MS,
            operationTimeoutMs: CACHE_CONFIG.HTTP_TIMEOUT_MS * 3,
            maxAttempts: CACHE_CONFIG.MAX_RETRIES + 1,
            ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
        });

        const persistentStore = new FileSystemCacheStore(options.cacheDir ?? CACHE_CONFIG.CACHE_DIR);

        this.gemCache = new TtlCache(persistentStore, {
            ttlMs: CACHE_CONFIG.CACHE_TTL_MS,
            negativeTtlMs: 5 * 60 * 1000,
            staleIfErrorMs: 24 * 60 * 60 * 1000,
        });

        this.versionsCache = new TtlCache(persistentStore, {
            ttlMs: CACHE_CONFIG.CACHE_TTL_MS,
            negativeTtlMs: 5 * 60 * 1000,
            staleIfErrorMs: 24 * 60 * 60 * 1000,
        });

        this.searchCache = new TtlCache(new MemoryCacheStore(), {
            ttlMs: CACHE_CONFIG.SEARCH_TTL_MS,
            negativeTtlMs: 60 * 1000,
        });
    }

    async getGem(name: string): Promise<RubyGemMetadata | null> {
        const key = createCacheKey('gem', name.toLowerCase());
        const result = await this.gemCache.get<RubyGemMetadata>(key, async (ctx) => {
            const res = await this.client.getJson<RubyGemMetadata>(
                `${this.baseUrl}/gems/${encodeURIComponent(name)}.json`,
                { headers: { ...COMMON_HEADERS }, conditional: ctx },
            );
            return toLoadResult(res);
        });
        return result.kind === 'value' ? (result.value ?? null) : null;
    }

    async getVersions(name: string): Promise<RubyGemVersion[]> {
        const key = createCacheKey('versions', name.toLowerCase());
        const result = await this.versionsCache.get<RubyGemVersion[]>(key, async (ctx) => {
            const res = await this.client.getJson<RubyGemVersion[]>(
                `${this.baseUrl}/versions/${encodeURIComponent(name)}.json`,
                { headers: { ...COMMON_HEADERS }, conditional: ctx },
            );
            return toLoadResult(res);
        });
        return result.kind === 'value' ? (result.value ?? []) : [];
    }

    async searchGems(query: string, page: number): Promise<RubyGemMetadata[]> {
        const trimmed = query.trim();
        if (!trimmed || page < 1) {
            return [];
        }
        const key = createCacheKey('search', trimmed.toLowerCase(), page);
        const result = await this.searchCache.get<RubyGemMetadata[]>(key, async () => {
            const url = new URL(`${this.baseUrl}/search.json`);
            url.searchParams.set('query', trimmed);
            url.searchParams.set('page', String(page));
            url.searchParams.set('per_page', String(CACHE_CONFIG.SEARCH_PER_PAGE));
            const res = await this.client.getJson<RubyGemMetadata[]>(url, { headers: { ...COMMON_HEADERS } });
            return toLoadResult(res);
        });
        return result.kind === 'value' ? (result.value ?? []) : [];
    }
}
