/**
 * Packagist upstream API service.
 *
 * Wraps the public Packagist JSON API and converts results into the
 * xRegistry-shaped objects consumed by the route handlers.
 *
 * Upstream access goes through the shared `@xregistry/registry-core`
 * `HttpUpstreamClient` (global fetch, retries, timeouts, conditional
 * requests) and is cached through the shared `TtlCache`. There is no axios
 * dependency and no bespoke cache implementation.
 *
 * Key upstream calls (all read-only / bounded):
 *   GET <base>/p2/<vendor>/<package>.json        (per-package metadata, v2 API)
 *   GET <base>/packages/<vendor>/<package>.json  (per-package metadata, v1 fallback)
 *   GET <base>/search.json?q=<q>&page=<n>        (search)
 */

import {
    HttpUpstreamClient,
    TtlCache,
    UpstreamError,
    isUpstreamError,
    createCacheKey,
    type CacheLoadResult,
    type ConditionalHttpResponse,
} from '@xregistry/registry-core';
import {
    GROUP_CONFIG,
    PACKAGIST_CONFIG,
    RESOURCE_CONFIG,
} from '../config/constants';
import type {
    PackagistPackage,
    PackagistPackageInfo,
    PackagistSearchResult,
    PackagistVersion,
} from '../types/packagist';
import type { XRegistryEntity, XRegistryResource, XRegistryVersion } from '../types/xregistry';
import {
    buildVersionId,
    decodePackageId,
    encodePackageId,
    isDevVersion,
} from '../utils/package-utils';

/** Minimal HTTP surface the service depends on (satisfied by HttpUpstreamClient). */
export interface UpstreamHttp {
    getJson<T>(
        url: string | URL,
        options?: { conditional?: { etag?: string } },
    ): Promise<ConditionalHttpResponse<T>>;
}

export interface PackagistServiceOptions {
    packagistBaseUrl?: string;
    http?: UpstreamHttp;
    cache?: TtlCache;
}

export interface PackageListEntry {
    packageid: string;
    name: string;
    description: string;
    /** xRegistry resource xid */
    xid: string;
}

/** Shape of the Packagist v2 (`/p2/…`) API response. */
interface PackagistV2Response {
    minified?: string;
    packages?: Record<string, PackagistVersion[]>;
}

/**
 * Inflate a Packagist "minified" (`composer/2.0`) version array.
 *
 * In the minified format the first (prototype) entry carries the full set of
 * fields; subsequent entries OMIT fields that are unchanged from the prototype
 * and only include fields that differ. Reconstruct each subsequent entry by
 * layering it on top of the prototype.
 */
export function inflateMinifiedVersions(versions: PackagistVersion[]): PackagistVersion[] {
    if (versions.length === 0) return [];
    const prototype = versions[0]!;
    return versions.map((v, i) => (i === 0 ? v : { ...prototype, ...v }));
}

/** Convert an upstream time string to ISO-8601, or undefined when absent/invalid. */
function toIso(time?: string): string | undefined {
    if (!time) return undefined;
    const ms = new Date(time).getTime();
    return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/**
 * Map a PackagistVersion into an xRegistry version entity.
 * Applies the critical dev-* immutability rule and stable version timestamps.
 */
function mapVersion(
    pkgName: string,
    pkgId: string,
    v: PackagistVersion,
    baseUrl: string,
): XRegistryVersion {
    const sourceRef = v.source?.reference ?? v.dist?.reference;
    const versionId = buildVersionId(v.version, v.version_normalized, sourceRef);
    const dev = isDevVersion(v.version);
    const xid = `/${GROUP_CONFIG.TYPE}/${GROUP_CONFIG.ID}/${RESOURCE_CONFIG.TYPE}/${pkgId}/versions/${versionId}`;
    const self = `${baseUrl}/${GROUP_CONFIG.TYPE}/${GROUP_CONFIG.ID}/${RESOURCE_CONFIG.TYPE}/${pkgId}/versions/${versionId}`;

    // Stable createdat/modifiedat: the version's own upstream time (or now()).
    const releaseTime = toIso(v.time) ?? new Date().toISOString();

    const entity: Record<string, unknown> = {
        xid,
        self,
        versionid: versionId,
        epoch: 1,
        createdat: releaseTime,
        modifiedat: releaseTime,
        name: `${pkgName}@${v.version}`,
        version: v.version,
        versionNormalized: v.version_normalized,
        // CRITICAL: mutable flag — dev aliases are not immutable releases
        immutable: !dev,
        type: v.type,
        license: v.license,
        authors: v.authors,
        require: v.require,
        requireDev: v['require-dev'],
        conflict: v.conflict,
        replace: v.replace,
        provide: v.provide,
        suggest: v.suggest,
        autoload: v.autoload,
        extra: v.extra,
    };

    if (v.description !== undefined) entity['description'] = v.description;
    if (sourceRef !== undefined) entity['sourceReference'] = sourceRef;
    if (v.dist !== undefined) entity['dist'] = v.dist;
    if (v.source !== undefined) entity['source'] = v.source;
    const iso = toIso(v.time);
    if (iso !== undefined) entity['time'] = iso;

    return entity as unknown as XRegistryVersion;
}

/**
 * Map a PackagistPackage into an xRegistry resource entity.
 * createdat/modifiedat are derived from the oldest/newest version times so
 * that timestamps are stable and deterministic for the same upstream data.
 */
function mapPackage(
    pkg: PackagistPackage,
    baseUrl: string,
): XRegistryResource & Record<string, unknown> {
    const pkgId = encodePackageId(pkg.name);
    const xid = `/${GROUP_CONFIG.TYPE}/${GROUP_CONFIG.ID}/${RESOURCE_CONFIG.TYPE}/${pkgId}`;
    const self = `${baseUrl}/${GROUP_CONFIG.TYPE}/${GROUP_CONFIG.ID}/${RESOURCE_CONFIG.TYPE}/${pkgId}`;

    const versions = Object.values(pkg.versions ?? {});
    const latestStable = versions.find(v => !isDevVersion(v.version));
    const displayVersion = latestStable?.version ?? versions[0]?.version;

    const times = versions
        .map(v => (v.time ? new Date(v.time).getTime() : NaN))
        .filter(n => !Number.isNaN(n));
    const now = new Date().toISOString();
    const createdat = times.length ? new Date(Math.min(...times)).toISOString() : now;
    const modifiedat = times.length ? new Date(Math.max(...times)).toISOString() : now;

    const entity: Record<string, unknown> = {
        xid,
        self,
        packageid: pkgId,
        epoch: 1,
        createdat,
        modifiedat,
        name: pkg.name,
        description: pkg.description,
        versionsurl: `${self}/versions`,
        versionscount: versions.length,
        metaurl: `${self}/meta`,
    };

    if (pkg.type !== undefined) entity['type'] = pkg.type;
    if (pkg.repository !== undefined) entity['repository'] = pkg.repository;
    if (pkg.downloads !== undefined) entity['downloads'] = pkg.downloads;
    if (pkg.favers !== undefined) entity['favers'] = pkg.favers;
    if (displayVersion !== undefined) entity['currentVersion'] = displayVersion;

    return entity as XRegistryResource & Record<string, unknown>;
}

export class PackagistService {
    private readonly http: UpstreamHttp;
    private readonly cache: TtlCache | undefined;
    private readonly baseUrl: string;

    constructor(options: PackagistServiceOptions = {}) {
        this.baseUrl = (options.packagistBaseUrl ?? PACKAGIST_CONFIG.BASE_URL).replace(/\/+$/, '');
        this.http = options.http ?? new HttpUpstreamClient();
        this.cache = options.cache;
    }

    // ─── Package metadata ───────────────────────────────────────────────────

    /**
     * Fetch full package metadata from Packagist (v2 API with v1 fallback).
     * Returns null if not found.
     */
    async fetchPackage(vendorPackage: string): Promise<PackagistPackage | null> {
        const loader = (etag?: string): Promise<CacheLoadResult<PackagistPackage>> =>
            this.loadPackage(vendorPackage, etag);

        if (this.cache) {
            const key = createCacheKey('pkg', vendorPackage);
            const result = await this.cache.get<PackagistPackage>(key, ctx => loader(ctx.etag));
            if (result.kind === 'not-found') return null;
            return result.value ?? null;
        }

        const loaded = await loader();
        if (loaded.kind === 'value') return loaded.value;
        return null;
    }

    private async loadPackage(
        vendorPackage: string,
        etag?: string,
    ): Promise<CacheLoadResult<PackagistPackage>> {
        const [vendor, pkg] = vendorPackage.split('/');
        const url = `${this.baseUrl}/p2/${vendor}/${pkg}.json`;
        try {
            const resp = await this.http.getJson<PackagistV2Response>(
                url,
                etag ? { conditional: { etag } } : {},
            );
            if ('notModified' in resp) {
                return { kind: 'not-modified', ...(resp.etag ? { etag: resp.etag } : {}) };
            }
            const transformed = this.transformV2(vendorPackage, resp.value);
            if (transformed) {
                return { kind: 'value', value: transformed, ...(resp.etag ? { etag: resp.etag } : {}) };
            }
            // v2 responded but did not contain this package → fall back to v1.
            return this.loadPackageV1(vendorPackage);
        } catch (e) {
            if (isUpstreamError(e) && e.code === 'not_found') {
                return this.loadPackageV1(vendorPackage);
            }
            throw e;
        }
    }

    private async loadPackageV1(vendorPackage: string): Promise<CacheLoadResult<PackagistPackage>> {
        const [vendor, pkg] = vendorPackage.split('/');
        const url = `${this.baseUrl}/packages/${vendor}/${pkg}.json`;
        try {
            const resp = await this.http.getJson<PackagistPackageInfo>(url);
            if ('notModified' in resp) return { kind: 'not-found' };
            const result = resp.value?.package ?? null;
            if (!result) return { kind: 'not-found' };
            return { kind: 'value', value: result, ...(resp.etag ? { etag: resp.etag } : {}) };
        } catch (e) {
            if (isUpstreamError(e) && e.code === 'not_found') return { kind: 'not-found' };
            throw e;
        }
    }

    /**
     * Transform a Packagist v2 response into a PackagistPackage, inflating the
     * minified `composer/2.0` array when present. Returns null when the
     * response does not describe the requested package.
     */
    private transformV2(
        vendorPackage: string,
        body: PackagistV2Response,
    ): PackagistPackage | null {
        const rawVersions = body.packages?.[vendorPackage];
        if (!rawVersions || rawVersions.length === 0) return null;

        const versionArray = body.minified === 'composer/2.0'
            ? inflateMinifiedVersions(rawVersions)
            : rawVersions;

        const versionsMap: Record<string, PackagistVersion> = {};
        for (const v of versionArray) {
            const key = buildVersionId(v.version, v.version_normalized, v.source?.reference ?? v.dist?.reference);
            versionsMap[key] = v;
        }

        const first = versionArray[0]!;
        const result: PackagistPackage = {
            name: vendorPackage,
            description: first.description ?? '',
            versions: versionsMap,
        };
        if (first.type !== undefined) result.type = first.type;
        if (first.source?.url !== undefined) result.repository = first.source.url;
        return result;
    }

    // ─── Search ─────────────────────────────────────────────────────────────

    /**
     * Search Packagist for packages.
     */
    async searchPackages(
        query: string,
        page = 1,
        perPage = 15,
    ): Promise<{ packages: PackageListEntry[]; total: number }> {
        const url = `${this.baseUrl}/search.json?q=${encodeURIComponent(query)}&page=${page}&per_page=${perPage}`;

        const load = async (): Promise<{ packages: PackageListEntry[]; total: number }> => {
            const resp = await this.http.getJson<PackagistSearchResult>(url);
            if ('notModified' in resp) return { packages: [], total: 0 };
            const data = resp.value;
            return {
                packages: (data.results ?? []).map(hit => ({
                    packageid: encodePackageId(hit.name),
                    name: hit.name,
                    description: hit.description ?? '',
                    xid: `/${GROUP_CONFIG.TYPE}/${GROUP_CONFIG.ID}/${RESOURCE_CONFIG.TYPE}/${encodePackageId(hit.name)}`,
                })),
                total: data.total ?? 0,
            };
        };

        if (this.cache) {
            const key = createCacheKey('search', query, page, perPage);
            const result = await this.cache.get<{ packages: PackageListEntry[]; total: number }>(
                key,
                async () => ({ kind: 'value', value: await load() }),
            );
            return result.value ?? { packages: [], total: 0 };
        }

        return load();
    }

    // ─── xRegistry entity builders ──────────────────────────────────────────

    /**
     * Fetch a package and return the full xRegistry resource entity.
     */
    async getPackageResource(
        vendorPackage: string,
        hostBaseUrl: string,
    ): Promise<(XRegistryResource & Record<string, unknown>) | null> {
        const pkg = await this.fetchPackage(vendorPackage);
        if (!pkg) return null;
        return mapPackage(pkg, hostBaseUrl);
    }

    /**
     * Return all xRegistry version entities for a package.
     */
    async getVersions(
        vendorPackage: string,
        hostBaseUrl: string,
    ): Promise<XRegistryVersion[]> {
        const pkg = await this.fetchPackage(vendorPackage);
        if (!pkg) return [];
        const pkgId = encodePackageId(vendorPackage);
        return Object.values(pkg.versions ?? {}).map(v =>
            mapVersion(vendorPackage, pkgId, v, hostBaseUrl),
        );
    }

    /**
     * Return a single xRegistry version entity.
     */
    async getVersion(
        vendorPackage: string,
        versionId: string,
        hostBaseUrl: string,
    ): Promise<XRegistryVersion | null> {
        const versions = await this.getVersions(vendorPackage, hostBaseUrl);
        return versions.find(v => v.versionid === versionId) ?? null;
    }

    /**
     * Build the xRegistry group entity for packagist.org.
     *
     * `createdat` and `modifiedat` are supplied by the caller so they can be
     * anchored to stable, process-lifetime values via EntityStateManager rather
     * than re-sampled on every call (which would invalidate ETags between
     * identical requests).
     *
     * Note: `packagescount` is intentionally omitted — Packagist does not
     * expose an authoritative package count without a full list traversal, and
     * emitting a fabricated count would violate the xRegistry count contract.
     */
    buildGroupEntity(
        hostBaseUrl: string,
        timestamps: { createdat: string; modifiedat: string },
    ): XRegistryEntity & Record<string, unknown> {
        const self = `${hostBaseUrl}/${GROUP_CONFIG.TYPE}/${GROUP_CONFIG.ID}`;
        return {
            xid: `/${GROUP_CONFIG.TYPE}/${GROUP_CONFIG.ID}`,
            self,
            [`${GROUP_CONFIG.TYPE}id`]: GROUP_CONFIG.ID,
            name: 'Packagist',
            description: 'The default Composer package repository for PHP.',
            documentation: 'https://packagist.org',
            epoch: 1,
            createdat: timestamps.createdat,
            modifiedat: timestamps.modifiedat,
            packagesurl: `${self}/${RESOURCE_CONFIG.TYPE}`,
        };
    }

    // ─── Internal helpers ────────────────────────────────────────────────────

    /** Resolve a vendor/package string from an xRegistry package ID (decodes ~ → /). */
    resolveVendorPackage(packageId: string): string {
        return decodePackageId(packageId);
    }
}

export { UpstreamError };
