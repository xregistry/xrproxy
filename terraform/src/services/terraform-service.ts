/**
 * Terraform Registry API client
 * Uses @xregistry/registry-core HttpUpstreamClient (retries, concurrency, cancellation)
 * and TtlCache/FileSystemCacheStore (atomic TTL cache with ETag revalidation).
 */

import {
    createCacheKey,
    FileSystemCacheStore,
    HttpUpstreamClient,
    isUpstreamError,
    TtlCache,
    type CacheLoadResult,
    type HttpClientOptions,
} from '@xregistry/registry-core';
import {
    FALLBACK_MODULES,
    FALLBACK_PROVIDERS,
    TERRAFORM_API,
} from '../config/constants';
import {
    encodeModuleId,
    encodeProviderId,
} from '../config/constants';
import {
    ModuleEntry,
    ProviderEntry,
    TFModuleVersionDetail,
    TFModuleVersionsResponse,
    TFProviderDownloadResponse,
    TFProviderVersionsResponse,
    TFV1ModuleSearchResponse,
    TFV2ProvidersResponse,
} from '../types/terraform';

/** Cache TTLs (ms) */
const TTL_MS = 6 * 60 * 60 * 1000;        // 6 h – version lists / search results
const PLATFORM_TTL_MS = 24 * 60 * 60 * 1000; // 24 h – download URLs are immutable
const NEGATIVE_TTL_MS = 10 * 60 * 1000;   // 10 min – 404 responses
const STALE_IF_ERROR_MS = 48 * 60 * 60 * 1000; // 48 h – serve stale on upstream error

export interface TerraformServiceOptions extends HttpClientOptions {
    cacheDir: string;
}

export class TerraformService {
    private readonly http: HttpUpstreamClient;
    private readonly cache: TtlCache;
    private readonly platformCache: TtlCache;

    constructor(options: TerraformServiceOptions) {
        this.http = new HttpUpstreamClient({
            timeoutMs: options.timeoutMs ?? 10_000,
            operationTimeoutMs: options.operationTimeoutMs ?? 30_000,
            maxAttempts: options.maxAttempts ?? 3,
            concurrency: options.concurrency ?? 8,
            ...options,
        });

        const store = new FileSystemCacheStore(options.cacheDir);
        const platformStore = new FileSystemCacheStore(`${options.cacheDir}/platforms`);

        this.cache = new TtlCache(store, {
            ttlMs: TTL_MS,
            negativeTtlMs: NEGATIVE_TTL_MS,
            staleIfErrorMs: STALE_IF_ERROR_MS,
        });

        this.platformCache = new TtlCache(platformStore, {
            ttlMs: PLATFORM_TTL_MS,
            negativeTtlMs: NEGATIVE_TTL_MS,
            staleIfErrorMs: STALE_IF_ERROR_MS,
        });
    }

    // -----------------------------------------------------------------------
    // Private helpers
    // -----------------------------------------------------------------------

    /** Fetch a JSON resource through the TTL cache */
    private async cachedGet<T>(url: string): Promise<T | null> {
        const key = createCacheKey(url);
        const result = await this.cache.get<T>(key, async (ctx) => {
            const resp = await this.http.getJson<T>(url, {
                conditional: ctx.etag ? { etag: ctx.etag } : ctx.lastModified ? { lastModified: ctx.lastModified } : undefined,
            });
            if ('notModified' in resp && resp.notModified) {
                return { kind: 'not-modified', etag: resp.etag, lastModified: resp.lastModified };
            }
            if (!('value' in resp)) {
                return { kind: 'not-found' };
            }
            return {
                kind: 'value',
                value: resp.value,
                etag: resp.etag,
                lastModified: resp.lastModified,
            } satisfies CacheLoadResult<T>;
        });
        return result.kind === 'value' ? result.value ?? null : null;
    }

    /** Fetch a JSON resource through the platform cache (longer TTL) */
    private async platformGet<T>(url: string): Promise<T | null> {
        const key = createCacheKey(url);
        const result = await this.platformCache.get<T>(key, async (ctx) => {
            const resp = await this.http.getJson<T>(url, {
                conditional: ctx.etag ? { etag: ctx.etag } : ctx.lastModified ? { lastModified: ctx.lastModified } : undefined,
            });
            if ('notModified' in resp && resp.notModified) {
                return { kind: 'not-modified', etag: resp.etag, lastModified: resp.lastModified };
            }
            if (!('value' in resp)) {
                return { kind: 'not-found' };
            }
            return {
                kind: 'value',
                value: resp.value,
                etag: resp.etag,
                lastModified: resp.lastModified,
            } satisfies CacheLoadResult<T>;
        });
        return result.kind === 'value' ? result.value ?? null : null;
    }

    // -----------------------------------------------------------------------
    // Provider catalogue
    // -----------------------------------------------------------------------

    async fetchProviderPage(pageNumber = 1, pageSize = 100): Promise<ProviderEntry[]> {
        const url = `${TERRAFORM_API.SEARCH_PROVIDERS}?page[number]=${pageNumber}&page[size]=${pageSize}&sort=-downloads`;
        try {
            const resp = await this.cachedGet<TFV2ProvidersResponse>(url);
            if (!resp?.data?.length) return this.fallbackProviders();
            return resp.data.map((d) => ({
                namespace: d.attributes.namespace,
                type: d.attributes.name,
                id: encodeProviderId(d.attributes.namespace, d.attributes.name),
            }));
        } catch {
            return this.fallbackProviders();
        }
    }

    private fallbackProviders(): ProviderEntry[] {
        return FALLBACK_PROVIDERS.map((p) => ({
            ...p,
            id: encodeProviderId(p.namespace, p.type),
        }));
    }

    async fetchProviderVersions(namespace: string, type: string): Promise<TFProviderVersionsResponse> {
        const url = TERRAFORM_API.providerVersionsUrl(namespace, type);
        const data = await this.cachedGet<TFProviderVersionsResponse>(url);
        if (!data) {
            throw new Error(`Provider ${namespace}/${type} not found`);
        }
        return data;
    }

    async fetchProviderPlatformDownload(
        namespace: string,
        type: string,
        version: string,
        os: string,
        arch: string
    ): Promise<TFProviderDownloadResponse | null> {
        const url = TERRAFORM_API.providerDownloadUrl(namespace, type, version, os, arch);
        try {
            return await this.platformGet<TFProviderDownloadResponse>(url);
        } catch (err) {
            if (isUpstreamError(err) && err.code === 'not_found') return null;
            return null;
        }
    }

    // -----------------------------------------------------------------------
    // Module catalogue
    // -----------------------------------------------------------------------

    async fetchModulePage(pageOffset = 0, limit = 100): Promise<ModuleEntry[]> {
        const url = `${TERRAFORM_API.SEARCH_MODULES}?offset=${pageOffset}&limit=${limit}&sort=downloads`;
        try {
            const resp = await this.cachedGet<TFV1ModuleSearchResponse>(url);
            if (!resp?.modules?.length) return this.fallbackModules();
            return resp.modules.map((m) => ({
                namespace: m.namespace,
                name: m.name,
                provider: m.provider,
                id: encodeModuleId(m.namespace, m.name, m.provider),
            }));
        } catch {
            return this.fallbackModules();
        }
    }

    private fallbackModules(): ModuleEntry[] {
        return FALLBACK_MODULES.map((m) => ({
            ...m,
            id: encodeModuleId(m.namespace, m.name, m.provider),
        }));
    }

    async fetchModuleVersions(namespace: string, name: string, provider: string): Promise<TFModuleVersionsResponse> {
        const url = TERRAFORM_API.moduleVersionsUrl(namespace, name, provider);
        const data = await this.cachedGet<TFModuleVersionsResponse>(url);
        if (!data) {
            throw new Error(`Module ${namespace}/${name}/${provider} not found`);
        }
        return data;
    }

    async fetchModuleVersion(
        namespace: string,
        name: string,
        provider: string,
        version: string
    ): Promise<TFModuleVersionDetail> {
        const url = TERRAFORM_API.moduleVersionUrl(namespace, name, provider, version);
        const data = await this.cachedGet<TFModuleVersionDetail>(url);
        if (!data) {
            throw new Error(`Module version ${namespace}/${name}/${provider}@${version} not found`);
        }
        return data;
    }

    async providerExists(namespace: string, type: string): Promise<boolean> {
        try {
            await this.fetchProviderVersions(namespace, type);
            return true;
        } catch {
            return false;
        }
    }

    async moduleExists(namespace: string, name: string, provider: string): Promise<boolean> {
        try {
            await this.fetchModuleVersions(namespace, name, provider);
            return true;
        } catch {
            return false;
        }
    }

    async fetchProviderV2Attributes(namespace: string, type: string): Promise<{
        description?: string;
        downloads?: number;
        tier?: string;
        logo_url?: string;
        categories?: string[];
        featured?: boolean;
        unlisted?: boolean;
        warning?: string;
        aliases?: string[];
    } | null> {
        const url = `${TERRAFORM_API.SEARCH_PROVIDERS}?filter[namespace]=${namespace}&filter[name]=${type}`;
        try {
            const resp = await this.cachedGet<TFV2ProvidersResponse>(url);
            const match = resp?.data?.find(
                (d) => d.attributes.namespace === namespace && d.attributes.name === type
            );
            if (!match) return null;
            const a = match.attributes;
            return {
                description: a.description,
                downloads: a.downloads,
                tier: a.tier,
                logo_url: a.logo_url,
                categories: a.categories,
                featured: a.featured,
                unlisted: a.unlisted,
                warning: a.warning,
                aliases: a.aliases,
            };
        } catch {
            return null;
        }
    }

    async fetchModuleSearchEntry(
        namespace: string,
        name: string,
        provider: string
    ): Promise<{
        downloads?: number;
        verified?: boolean;
        trusted?: boolean;
        owner?: string;
        description?: string;
    } | null> {
        const url = `${TERRAFORM_API.SEARCH_MODULES}/${namespace}/${name}/${provider}`;
        try {
            const resp = await this.cachedGet<TFModuleVersionDetail>(url);
            if (!resp) return null;
            return {
                downloads: resp.downloads,
                verified: resp.verified,
                owner: resp.owner,
                description: resp.description,
            };
        } catch {
            return null;
        }
    }
}
