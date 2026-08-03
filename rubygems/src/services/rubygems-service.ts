import {
    CacheLoadResult,
    ConditionalHttpResponse,
    HttpUpstreamClient,
    TtlCache,
    FileSystemCacheStore,
    MemoryCacheStore,
    createCacheKey,
    isUpstreamError,
} from '@xregistry/registry-core';
import { CACHE_CONFIG, RUBYGEMS_API } from '../config/constants';
import { RubyGemMetadata, RubyGemOwner, RubyGemUpstreamOwner, RubyGemVersion } from '../types/xregistry';

const COMMON_HEADERS: Readonly<Record<string, string>> = {
    'User-Agent': RUBYGEMS_API.USER_AGENT,
    Accept: 'application/json',
};

export interface RubyGemsServiceOptions {
    readonly cacheDir?: string;
    readonly baseUrl?: string;
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
    private readonly ownersCache: TtlCache;
    private readonly reverseDependenciesCache: TtlCache;
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
        const sharedConfig = {
            ttlMs: CACHE_CONFIG.CACHE_TTL_MS,
            negativeTtlMs: 5 * 60 * 1000,
            staleIfErrorMs: 24 * 60 * 60 * 1000,
        } as const;

        this.gemCache = new TtlCache(persistentStore, sharedConfig);
        this.versionsCache = new TtlCache(persistentStore, sharedConfig);
        this.ownersCache = new TtlCache(persistentStore, sharedConfig);
        this.reverseDependenciesCache = new TtlCache(persistentStore, sharedConfig);

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

    async getOwners(name: string): Promise<RubyGemOwner[]> {
        const key = createCacheKey('owners', name);
        const result = await this.ownersCache.get<RubyGemUpstreamOwner[]>(key, async (ctx) => {
            try {
                const res = await this.requestGate.run(() => this.client.getJson<RubyGemUpstreamOwner[]>(
                    `${this.baseUrl}/gems/${encodeURIComponent(name)}/owners.json`,
                    { headers: { ...COMMON_HEADERS }, conditional: ctx },
                ));
                return toLoadResult(res);
            } catch (error) {
                if (isUpstreamError(error) && error.status === 404) {
                    return { kind: 'not-found' };
                }
                throw error;
            }
        });
        if (result.kind !== 'value' || !Array.isArray(result.value)) {
            return [];
        }
        const owners: RubyGemOwner[] = [];
        for (const owner of result.value) {
            const handle = [owner.handle, owner.owner, owner.name, owner.email]
                .find((value): value is string => typeof value === 'string' && value.length > 0);
            if (!handle) {
                continue;
            }
            owners.push({
                handle,
                ...(typeof owner.role === 'string' && owner.role.length > 0 ? { role: owner.role } : { role: 'owner' }),
            });
        }
        return owners;
    }

    async getReverseDependencies(name: string): Promise<string[]> {
        const key = createCacheKey('reverse-dependencies', name);
        const result = await this.reverseDependenciesCache.get<string[]>(key, async (ctx) => {
            try {
                const res = await this.requestGate.run(() => this.client.getJson<string[]>(
                    `${this.baseUrl}/gems/${encodeURIComponent(name)}/reverse_dependencies.json`,
                    { headers: { ...COMMON_HEADERS }, conditional: ctx },
                ));
                return toLoadResult(res);
            } catch (error) {
                if (isUpstreamError(error) && error.status === 404) {
                    return { kind: 'not-found' };
                }
                throw error;
            }
        });
        return result.kind === 'value' && Array.isArray(result.value)
            ? result.value.filter((item): item is string => typeof item === 'string' && item.length > 0)
            : [];
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
