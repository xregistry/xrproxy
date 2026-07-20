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
    PackagistPackageListResult,
    PackagistSearchResult,
    PackagistVersion,
} from '../types/packagist';
import type { XRegistryEntity, XRegistryResource, XRegistryVersion } from '../types/xregistry';
import {
    buildVersionId,
    identityToPackageName,
    isDevVersion,
    isValidPackageName,
    packageNameToIdentity,
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
    vendor: string;
    name: string;
    packagepath: string;
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
 * fields; each subsequent entry is a delta from the previously reconstructed
 * entry. Reconstructing every delta from the first prototype loses changes
 * inherited through intermediate versions.
 */
export function inflateMinifiedVersions(versions: PackagistVersion[]): PackagistVersion[] {
    if (versions.length === 0) return [];
    const inflatedVersions: PackagistVersion[] = [];
    let previous: Record<string, unknown> = {};
    for (const version of versions) {
        const inflated: Record<string, unknown> = { ...previous };
        for (const [key, value] of Object.entries(version as unknown as Record<string, unknown>)) {
            if (value === '__unset') delete inflated[key];
            else inflated[key] = value;
        }
        previous = inflated;
        inflatedVersions.push(inflated as unknown as PackagistVersion);
    }
    return inflatedVersions;
}

/** Convert an upstream time string to ISO-8601, or undefined when absent/invalid. */
function toIso(time?: string): string | undefined {
    if (!time) return undefined;
    const ms = new Date(time).getTime();
    return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

const UNKNOWN_VERSION_TIME = '1970-01-01T00:00:00.000Z';

function versionIdOf(version: PackagistVersion): string {
    return buildVersionId(
        version.version,
        version.version_normalized,
        version.source?.reference ?? version.dist?.reference,
    );
}

/** xRegistry `createdat` ordering with the required version-ID tie-breaker. */
function sortRawVersions(versions: readonly PackagistVersion[]): PackagistVersion[] {
    return [...versions].sort((a, b) => {
        const timeCompare = (toIso(a.time) ?? UNKNOWN_VERSION_TIME)
            .localeCompare(toIso(b.time) ?? UNKNOWN_VERSION_TIME);
        return timeCompare || versionIdOf(a).localeCompare(versionIdOf(b), undefined, { sensitivity: 'base' });
    });
}

function selectDefaultVersion(versions: readonly PackagistVersion[]): PackagistVersion | undefined {
    // versionmode=createdat and defaultversionsticky=false require the newest
    // Version in the canonical merged snapshot to be the default.
    return sortRawVersions(versions).at(-1);
}

/**
 * Map a PackagistVersion into an xRegistry version entity.
 * Applies the critical dev-* immutability rule and stable version timestamps.
 */
function mapVersion(
    pkgName: string,
    v: PackagistVersion,
    baseUrl: string,
    defaultVersionId: string | undefined,
): XRegistryVersion {
    const sourceRef = v.source?.reference ?? v.dist?.reference;
    const versionId = buildVersionId(v.version, v.version_normalized, sourceRef);
    const dev = isDevVersion(v.version);
    const { groupId, resourceId } = packageNameToIdentity(pkgName);
    const xid = `/${GROUP_CONFIG.TYPE}/${groupId}/${RESOURCE_CONFIG.TYPE}/${resourceId}/versions/${versionId}`;
    const self = `${baseUrl}/${GROUP_CONFIG.TYPE}/${encodeURIComponent(groupId)}/${RESOURCE_CONFIG.TYPE}/${encodeURIComponent(resourceId)}/versions/${encodeURIComponent(versionId)}`;

    // Keep timestamps deterministic even when malformed upstream data omits time.
    const releaseTime = toIso(v.time) ?? UNKNOWN_VERSION_TIME;

    const entity: Record<string, unknown> = {
        xid,
        self,
        versionid: versionId,
        packageid: resourceId,
        isdefault: versionId === defaultVersionId,
        ancestor: versionId,
        epoch: 1,
        createdat: releaseTime,
        modifiedat: releaseTime,
        name: pkgName,
        vendor: groupId,
        packagepath: pkgName,
        version: v.version,
        versionnormalized: v.version_normalized,
        // CRITICAL: mutable flag — dev aliases are not immutable releases
        immutable: !dev,
        type: v.type,
        license: v.license,
        authors: v.authors,
        require: v.require,
        requiredev: v['require-dev'],
        conflict: v.conflict,
        replace: v.replace,
        provide: v.provide,
        suggest: v.suggest,
        autoload: v.autoload,
        extra: v.extra,
    };

    if (v.description !== undefined) entity['description'] = v.description;
    if (v.homepage !== undefined) entity['homepage'] = v.homepage;
    if (v.keywords !== undefined) entity['keywords'] = v.keywords;
    if (v.abandoned !== undefined) entity['abandoned'] = v.abandoned;
    if (v.source?.url !== undefined) entity['repository'] = v.source.url;
    if (sourceRef !== undefined) entity['sourcereference'] = sourceRef;
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
    const { groupId, resourceId } = packageNameToIdentity(pkg.name);
    const xid = `/${GROUP_CONFIG.TYPE}/${groupId}/${RESOURCE_CONFIG.TYPE}/${resourceId}`;
    const self = `${baseUrl}/${GROUP_CONFIG.TYPE}/${encodeURIComponent(groupId)}/${RESOURCE_CONFIG.TYPE}/${encodeURIComponent(resourceId)}`;
    const versions = sortRawVersions(Object.values(pkg.versions ?? {}));
    const defaultVersion = selectDefaultVersion(versions);
    if (!defaultVersion) {
        throw new UpstreamError({
            code: 'invalid_response',
            message: `Packagist package ${pkg.name} has no versions`,
        });
    }
    const defaultVersionId = versionIdOf(defaultVersion);
    const projected = mapVersion(pkg.name, defaultVersion, baseUrl, defaultVersionId) as unknown as Record<string, unknown>;
    const defaultIndex = versions.findIndex(version => versionIdOf(version) === defaultVersionId);
    projected['ancestor'] = defaultIndex > 0 ? versionIdOf(versions[defaultIndex - 1]!) : defaultVersionId;

    return {
        ...projected,
        packageid: resourceId,
        xid,
        self,
        metaurl: `${self}/meta`,
        versionsurl: `${self}/versions`,
        versionscount: versions.length,
    } as unknown as XRegistryResource & Record<string, unknown>;
}

function mapPackageMeta(pkg: PackagistPackage, baseUrl: string): Record<string, unknown> {
    const { groupId, resourceId } = packageNameToIdentity(pkg.name);
    const versions = sortRawVersions(Object.values(pkg.versions ?? {}));
    const defaultVersion = selectDefaultVersion(versions);
    if (!defaultVersion) {
        throw new UpstreamError({ code: 'invalid_response', message: `Packagist package ${pkg.name} has no versions` });
    }
    const defaultVersionId = versionIdOf(defaultVersion);
    const latestStable = [...versions].reverse().find(version => !isDevVersion(version.version));
    const self = `${baseUrl}/${GROUP_CONFIG.TYPE}/${encodeURIComponent(groupId)}/${RESOURCE_CONFIG.TYPE}/${encodeURIComponent(resourceId)}`;
    const createdat = toIso(versions[0]?.time) ?? UNKNOWN_VERSION_TIME;
    const modifiedat = toIso(defaultVersion.time) ?? createdat;
    return {
        packageid: resourceId,
        xid: `/${GROUP_CONFIG.TYPE}/${groupId}/${RESOURCE_CONFIG.TYPE}/${resourceId}/meta`,
        self: `${self}/meta`,
        epoch: 1,
        createdat,
        modifiedat,
        readonly: true,
        compatibility: 'none',
        defaultversionid: defaultVersionId,
        defaultversionurl: `${self}/versions/${encodeURIComponent(defaultVersionId)}`,
        defaultversionsticky: false,
        ...(pkg.downloads !== undefined ? { downloads: pkg.downloads } : {}),
        ...(pkg.favers !== undefined ? { favers: pkg.favers } : {}),
        ...(latestStable?.version !== undefined ? { currentversion: latestStable.version } : {}),
    };
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
        // Validate without normalizing: xRegistry entity lookup is case-sensitive.
        packageNameToIdentity(vendorPackage);
        const loader = (): Promise<CacheLoadResult<PackagistPackage>> => this.loadPackage(vendorPackage);
        const rejectWrongCase = (pkg: PackagistPackage | null): PackagistPackage | null => {
            if (!pkg) return null;
            const canonical = packageNameToIdentity(pkg.name).canonicalName;
            return canonical.toLowerCase() === vendorPackage.toLowerCase() && canonical !== vendorPackage
                ? null
                : pkg;
        };

        if (this.cache) {
            const key = createCacheKey('pkg', vendorPackage);
            const result = await this.cache.get<PackagistPackage>(key, loader);
            if (result.kind === 'not-found') return null;
            return rejectWrongCase(result.value ?? null);
        }

        const loaded = await loader();
        return loaded.kind === 'value' ? rejectWrongCase(loaded.value) : null;
    }

    private async loadPackage(
        vendorPackage: string,
    ): Promise<CacheLoadResult<PackagistPackage>> {
        const [vendor, pkg] = vendorPackage.split('/');
        const stableUrl = `${this.baseUrl}/p2/${vendor}/${pkg}.json`;
        const developmentUrl = `${this.baseUrl}/p2/${vendor}/${pkg}~dev.json`;
        const [stable, development] = await Promise.all([
            this.loadV2Feed(stableUrl),
            this.loadV2Feed(developmentUrl),
        ]);

        const merged = this.mergeV2Feeds(vendorPackage, [stable, development]);
        if (merged) return { kind: 'value', value: merged };
        return this.loadPackageV1(vendorPackage);
    }

    private async loadV2Feed(url: string): Promise<PackagistV2Response | null> {
        try {
            const response = await this.http.getJson<PackagistV2Response>(url);
            return 'notModified' in response ? null : response.value;
        } catch (error) {
            if (isUpstreamError(error) && error.code === 'not_found') return null;
            throw error;
        }
    }

    /** Merge stable and ~dev feeds using the canonical injective Version IDs. */
    private mergeV2Feeds(
        vendorPackage: string,
        feeds: readonly (PackagistV2Response | null)[],
    ): PackagistPackage | null {
        const packages = feeds
            .filter((feed): feed is PackagistV2Response => feed !== null)
            .map(feed => this.transformV2(vendorPackage, feed))
            .filter((pkg): pkg is PackagistPackage => pkg !== null);
        if (packages.length === 0) return null;

        const versions: Record<string, PackagistVersion> = {};
        for (const pkg of packages) {
            for (const version of Object.values(pkg.versions ?? {})) {
                const versionId = versionIdOf(version);
                // A Version present in both feeds is one logical Version. Dev
                // IDs include the full alias and source reference, while stable
                // IDs use Composer's canonical normalized version.
                versions[versionId] ??= version;
            }
        }

        const primary = packages[0]!;
        return {
            ...primary,
            description: primary.description || packages.find(pkg => pkg.description)?.description || '',
            versions,
        };
    }

    private async loadPackageV1(vendorPackage: string): Promise<CacheLoadResult<PackagistPackage>> {
        const [vendor, pkg] = vendorPackage.split('/');
        const url = `${this.baseUrl}/packages/${vendor}/${pkg}.json`;
        try {
            const resp = await this.http.getJson<PackagistPackageInfo>(url);
            if ('notModified' in resp) return { kind: 'not-found' };
            const result = resp.value?.package ?? null;
            if (!result) return { kind: 'not-found' };
            const canonicalName = packageNameToIdentity(result.name).canonicalName;
            return {
                kind: 'value',
                value: { ...result, name: canonicalName },
                ...(resp.etag ? { etag: resp.etag } : {}),
            };
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
        const match = Object.entries(body.packages ?? {}).find(
            ([name]) => name.toLowerCase() === vendorPackage.toLowerCase(),
        );
        if (!match || match[1].length === 0) return null;
        const canonicalName = packageNameToIdentity(match[0]).canonicalName;
        const rawVersions = match[1];
        const versionArray = body.minified === 'composer/2.0'
            ? inflateMinifiedVersions(rawVersions)
            : rawVersions;

        const versionsMap: Record<string, PackagistVersion> = {};
        for (const version of versionArray) {
            const key = buildVersionId(
                version.version,
                version.version_normalized,
                version.source?.reference ?? version.dist?.reference,
            );
            versionsMap[key] = version;
        }

        const first = versionArray[0]!;
        const result: PackagistPackage = {
            name: canonicalName,
            description: first.description ?? '',
            versions: versionsMap,
        };
        if (first.type !== undefined) result.type = first.type;
        if (first.source?.url !== undefined) result.repository = first.source.url;
        return result;
    }

    // ─── Search ─────────────────────────────────────────────────────────────

    /**
     * Return a page from Packagist's complete package-name list.
     * This endpoint supports collection browsing without sending the invalid
     * empty `q` parameter to `/search.json`.
     */
    async listPackages(
        offset = 0,
        limit = 15,
    ): Promise<{ packages: PackageListEntry[]; total: number }> {
        const names = await this.getPackageNames();
        return {
            packages: names.slice(offset, offset + limit).map(name => this.toPackageListEntry(name)),
            total: names.length,
        };
    }

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
                packages: (data.results ?? [])
                    .filter(hit => isValidPackageName(hit.name))
                    .map(hit => this.toPackageListEntry(hit.name, hit.description ?? '')),
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

    /** Translate xRegistry offset/limit pagination to Packagist's page API. */
    async searchPackagesAtOffset(
        query: string,
        offset = 0,
        limit = 15,
    ): Promise<{ packages: PackageListEntry[]; total: number }> {
        const page = Math.floor(offset / limit) + 1;
        const inPageOffset = offset % limit;
        const first = await this.searchPackages(query, page, limit);
        if (inPageOffset === 0 || first.packages.length < limit) {
            return {
                packages: first.packages.slice(inPageOffset, inPageOffset + limit),
                total: first.total,
            };
        }

        const second = await this.searchPackages(query, page + 1, limit);
        return {
            packages: [...first.packages, ...second.packages]
                .slice(inPageOffset, inPageOffset + limit),
            total: first.total,
        };
    }

    /** Filter the complete Packagist name catalog, then paginate exact matches. */
    async searchPackagesByPrefix(
        prefix: string,
        offset = 0,
        limit = 15,
    ): Promise<{ packages: PackageListEntry[]; total: number }> {
        const normalizedPrefix = prefix.toLowerCase();
        const matchingNames = (await this.getPackageNames())
            .filter(name => name.toLowerCase().startsWith(normalizedPrefix));
        return {
            packages: matchingNames.slice(offset, offset + limit)
                .map(name => this.toPackageListEntry(name)),
            total: matchingNames.length,
        };
    }

    async getPackageNames(): Promise<string[]> {
        const url = `${this.baseUrl}/packages/list.json`;
        const load = async (): Promise<CacheLoadResult<PackagistPackageListResult>> => {
            const resp = await this.http.getJson<PackagistPackageListResult>(url);
            if ('notModified' in resp) return { kind: 'not-modified' };
            return { kind: 'value', value: resp.value };
        };

        if (this.cache) {
            const result = await this.cache.get<PackagistPackageListResult>(
                createCacheKey('package-list'),
                load,
            );
            return [...new Set((result.value?.packageNames ?? result.value?.packages ?? [])
                .filter(isValidPackageName)
                .map(name => packageNameToIdentity(name).canonicalName))];
        }

        const result = await load();
        return result.kind === 'value'
            ? [...new Set((result.value.packageNames ?? result.value.packages ?? [])
                .filter(isValidPackageName)
                .map(name => packageNameToIdentity(name).canonicalName))]
            : [];
    }

    private toPackageListEntry(name: string, description = ''): PackageListEntry {
        const { groupId, resourceId } = packageNameToIdentity(name);
        return {
            packageid: resourceId,
            vendor: groupId,
            name,
            packagepath: name,
            description,
            xid: `/${GROUP_CONFIG.TYPE}/${groupId}/${RESOURCE_CONFIG.TYPE}/${resourceId}`,
        };
    }

    async listVendors(): Promise<Array<{ id: string; packagescount: number }>> {
        const counts = new Map<string, number>();
        for (const name of await this.getPackageNames()) {
            const { groupId } = packageNameToIdentity(name);
            counts.set(groupId, (counts.get(groupId) ?? 0) + 1);
        }
        return [...counts.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([id, packagescount]) => ({ id, packagescount }));
    }

    async listVendorPackages(vendor: string): Promise<PackageListEntry[]> {
        return (await this.getPackageNames())
            .filter(name => packageNameToIdentity(name).groupId === vendor)
            .map(name => this.toPackageListEntry(name));
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

    async getPackageMeta(
        vendorPackage: string,
        hostBaseUrl: string,
    ): Promise<Record<string, unknown> | null> {
        const pkg = await this.fetchPackage(vendorPackage);
        return pkg ? mapPackageMeta(pkg, hostBaseUrl) : null;
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
        const versions = sortRawVersions(Object.values(pkg.versions ?? {}));
        const defaultVersion = selectDefaultVersion(versions);
        const defaultVersionId = defaultVersion ? versionIdOf(defaultVersion) : undefined;
        const ordered = versions.map(v =>
            mapVersion(pkg.name, v, hostBaseUrl, defaultVersionId),
        );
        ordered.forEach((version, index) => {
            version.ancestor = index === 0 ? version.versionid : ordered[index - 1]!.versionid;
        });
        return ordered;
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

    /** Build one Composer vendor group entity from the discovery catalogue. */
    buildGroupEntity(
        hostBaseUrl: string,
        vendor: string,
        packagescount: number,
        timestamps: { createdat: string; modifiedat: string },
    ): XRegistryEntity & Record<string, unknown> {
        const groupPath = `/${GROUP_CONFIG.TYPE}/${vendor}`;
        const self = `${hostBaseUrl}/${GROUP_CONFIG.TYPE}/${encodeURIComponent(vendor)}`;
        return {
            xid: groupPath,
            self,
            [`${GROUP_CONFIG.TYPE_SINGULAR}id`]: vendor,
            name: vendor,
            vendor,
            description: `Composer packages published by ${vendor} on Packagist.`,
            documentation: `https://packagist.org/packages/${encodeURIComponent(vendor)}/`,
            epoch: 1,
            createdat: timestamps.createdat,
            modifiedat: timestamps.modifiedat,
            packagesurl: `${self}/${RESOURCE_CONFIG.TYPE}`,
            packagescount,
        };
    }

    /** Resolve native group/resource IDs without consulting discovery. */
    resolveVendorPackage(groupId: string, packageId: string): string {
        return identityToPackageName(groupId, packageId);
    }
}

export { UpstreamError };
