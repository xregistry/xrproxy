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
    readonly rateLimitPerSecond?: number;
    readonly maxConcurrency?: number;
}

class RequestGate {
    private nextStart = 0;
    private startTail: Promise<void> = Promise.resolve();
    private active = 0;
    private readonly waiters: Array<() => void> = [];

    constructor(private readonly intervalMs: number, private readonly maxConcurrency: number) {}

    private async acquire(): Promise<void> {
        if (this.active < this.maxConcurrency) {
            this.active += 1;
            return;
        }
        await new Promise<void>(resolve => this.waiters.push(resolve));
        this.active += 1;
    }

    private release(): void {
        this.active -= 1;
        this.waiters.shift()?.();
    }

    async run<T>(operation: () => Promise<T>): Promise<T> {
        const turn = this.startTail.then(async () => {
            const delay = Math.max(0, this.nextStart - Date.now());
            if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
            this.nextStart = Date.now() + this.intervalMs;
        });
        this.startTail = turn.catch(() => undefined);
        await turn;
        await this.acquire();
        try {
            return await operation();
        } finally {
            this.release();
        }
    }
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
    private readonly requestGate: RequestGate;

    constructor(options: RubyGemsServiceOptions = {}) {
        this.baseUrl = (options.baseUrl ?? RUBYGEMS_API.BASE_URL).replace(/\/$/, '');

        const requestsPerSecond = Math.max(1, Math.min(options.rateLimitPerSecond ?? 10, 10));
        this.requestGate = new RequestGate(
            Math.ceil(1000 / requestsPerSecond) + 1,
            Math.max(1, Math.min(options.maxConcurrency ?? 2, 10)),
        );

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
        const key = createCacheKey('gem', name);
        const result = await this.gemCache.get<RubyGemMetadata>(key, async (ctx) => {
            const res = await this.requestGate.run(() => this.client.getJson<RubyGemMetadata>(
                `${this.baseUrl}/gems/${encodeURIComponent(name)}.json`,
                { headers: { ...COMMON_HEADERS }, conditional: ctx },
            ));
            if (!("notModified" in res) && res.value.name !== name) return { kind: "not-found" };
            return toLoadResult(res);
        });
        return result.kind === 'value' ? (result.value ?? null) : null;
    }

    async getVersions(name: string): Promise<RubyGemVersion[]> {
        const key = createCacheKey('versions', name);
        const result = await this.versionsCache.get<RubyGemVersion[]>(key, async (ctx) => {
            const res = await this.requestGate.run(() => this.client.getJson<RubyGemVersion[]>(
                `${this.baseUrl}/versions/${encodeURIComponent(name)}.json`,
                { headers: { ...COMMON_HEADERS }, conditional: ctx },
            ));
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
            const res = await this.requestGate.run(() =>
                this.client.getJson<RubyGemMetadata[]>(url, { headers: { ...COMMON_HEADERS } }),
            );
            return toLoadResult(res);
        });
        return result.kind === 'value' ? (result.value ?? []) : [];
    }
}
