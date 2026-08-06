/**
 * NPM Registry Service
 * @fileoverview Service for interacting with the npm registry and projecting it into xRegistry.
 */

import axios, { AxiosInstance } from 'axios';
import { CacheManager } from '../cache/cache-manager';
import { CACHE_CONFIG, GROUP_CONFIG, NPM_REGISTRY } from '../config/constants';
import {
    BundleDependencyReference,
    DependencyReference,
    DistMetadata,
    PackageMetadata,
    Person,
    VersionMetadata,
} from '../types/xregistry';
import {
    encodePackageName,    findVersionById,
    getNodescopeId,
    isValidPackageName,
    matchesPackageIdentity,
    normalizePackageId,
    normalizeVersionId,
    toPackageXid,
} from '../utils/package-utils';
import { generateXRegistryEntity } from '../utils/xregistry-utils';

export type NpmPerson = string | { name?: string | undefined; email?: string | undefined; url?: string | undefined };
export type NpmObjectField = string | Record<string, unknown>;

/**
 * NPM package manifest from registry.
 */
export interface NpmPackageManifest {
    _id: string;
    _rev?: string;
    name: string;
    description?: string;
    'dist-tags': Record<string, string>;
    versions: Record<string, NpmVersionManifest>;
    time?: Record<string, string>;
    maintainers?: NpmPerson[];
    author?: NpmPerson;
    contributors?: NpmPerson[];
    repository?: NpmObjectField;
    homepage?: string;
    bugs?: NpmObjectField;
    license?: string;
    keywords?: string[];
    replacedBy?: string;
    replacedby?: string;
    readme?: string;
    readmeFilename?: string;
}

/**
 * NPM version manifest.
 */
export interface NpmVersionManifest {
    name: string;
    version: string;
    description?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    bundleDependencies?: string[];
    bundledDependencies?: string[];
    engines?: Record<string, string>;
    os?: string[];
    cpu?: string[];
    keywords?: string[];
    author?: NpmPerson;
    maintainers?: NpmPerson[];
    contributors?: NpmPerson[];
    license?: string;
    repository?: NpmObjectField;
    bugs?: NpmObjectField;
    homepage?: string;
    deprecated?: string;
    replacedBy?: string;
    replacedby?: string;
    dist: {
        integrity?: string;
        shasum?: string;
        tarball: string;
        fileCount?: number;
        unpackedSize?: number;
        'npm-signature'?: string;
    };
    _id: string;
    _nodeVersion?: string;
    _npmVersion?: string;
    _npmUser?: { name: string; email: string };
    _hasShrinkwrap?: boolean;
}

export interface NpmServiceConfig {
    registryUrl?: string;
    timeout?: number;
    userAgent?: string;
    cacheManager?: CacheManager;
    cacheTtl?: number;
    knownPackageNames?: Iterable<string>;
}

interface SearchPackageResult {
    name: string;
    version?: string;
    description?: string;
    keywords?: string[];
    date?: string;
    links?: Record<string, string>;
    author?: NpmPerson;
    maintainers?: Array<{ username?: string; email?: string; name?: string; url?: string }>;
}

export class NpmService {
    private readonly httpClient: AxiosInstance;
    private readonly cacheManager: CacheManager | undefined;
    private readonly cacheTtl: number;
    private knownPackageNames?: string[];
    private knownPackageNameSet?: Set<string>;
    private packageIdentityMap?: Map<string, string>;

    constructor(config: NpmServiceConfig = {}) {
        this.httpClient = axios.create({
            baseURL: config.registryUrl || NPM_REGISTRY.BASE_URL,
            timeout: config.timeout || 30000,
            headers: {
                'User-Agent': config.userAgent || NPM_REGISTRY.USER_AGENT,
                'Accept': 'application/json',
            },
        });

        this.cacheManager = config.cacheManager;
        this.cacheTtl = config.cacheTtl || CACHE_CONFIG.CACHE_TTL_MS;

        if (config.knownPackageNames) {
            this.knownPackageNames = Array.from(config.knownPackageNames);
            this.knownPackageNameSet = new Set(this.knownPackageNames);
        }
    }

    async getPackageMetadata(packageName: string): Promise<PackageMetadata | null> {
        try {
            const cacheKey = CacheManager.generatePackageKey(packageName);
            if (this.cacheManager) {
                const cached = await this.cacheManager.get<PackageMetadata>(cacheKey);
                if (cached) {
                    return cached;
                }
            }

            const response = await this.fetchPackument(packageName);
            if (response.status !== 200 || !response.data) {
                return null;
            }

            const packageMetadata = this.convertToPackageMetadata(response.data);
            if (this.cacheManager) {
                await this.cacheManager.set(cacheKey, packageMetadata, {
                    ttl: this.cacheTtl,
                    etag: response.headers['etag'],
                    lastModified: response.headers['last-modified'],
                });
            }

            return packageMetadata;
        } catch (error) {
            console.error(`Failed to fetch package metadata for ${packageName}:`, error);
            return null;
        }
    }

    async getVersionMetadata(packageName: string, version: string): Promise<VersionMetadata | null> {
        try {
            const cacheKey = CacheManager.generatePackageKey(packageName, version);
            if (this.cacheManager) {
                const cached = await this.cacheManager.get<VersionMetadata>(cacheKey);
                if (cached) {
                    return cached;
                }
            }

            const response = await this.fetchPackument(packageName);
            if (response.status !== 200 || !response.data) {
                return null;
            }

            const npmManifest = response.data;
            const upstreamVersion = findVersionById(version, Object.keys(npmManifest.versions)) || version;
            const npmVersion = npmManifest.versions[upstreamVersion];
            if (!npmVersion) {
                return null;
            }

            const versionMetadata = this.convertToVersionMetadata(npmManifest, npmVersion);
            if (this.cacheManager) {
                await this.cacheManager.set(cacheKey, versionMetadata, {
                    ttl: this.cacheTtl,
                    etag: response.headers['etag'],
                    lastModified: response.headers['last-modified'],
                });
            }

            return versionMetadata;
        } catch (error) {
            console.error(`Failed to fetch version metadata for ${packageName}@${version}:`, error);
            return null;
        }
    }

    async packageExists(packageName: string): Promise<boolean> {
        try {
            const response = await this.httpClient.head(`/${encodePackageName(packageName)}`);
            return response.status === 200;
        } catch {
            return false;
        }
    }

    async versionExists(packageName: string, version: string): Promise<boolean> {
        const packageMetadata = await this.getPackageMetadata(packageName);
        return !!packageMetadata && !!findVersionById(version, Object.keys(packageMetadata.versions || {}));
    }

    async getPackageTarball(packageName: string, version: string): Promise<Buffer | null> {
        try {
            const cacheKey = CacheManager.generateTarballKey(packageName, version);
            if (this.cacheManager) {
                const cached = await this.cacheManager.get<string>(cacheKey);
                if (cached) {
                    return Buffer.from(cached, 'base64');
                }
            }

            const versionMetadata = await this.getVersionMetadata(packageName, version);
            if (!versionMetadata?.dist?.tarball) {
                return null;
            }

            const response = await this.httpClient.get(versionMetadata.dist.tarball, {
                responseType: 'arraybuffer',
            });
            if (response.status !== 200) {
                return null;
            }

            const buffer = Buffer.from(response.data);
            if (this.cacheManager) {
                await this.cacheManager.set(cacheKey, buffer.toString('base64'), {
                    ttl: this.cacheTtl * 10,
                    etag: response.headers['etag'],
                    lastModified: response.headers['last-modified'],
                });
            }

            return buffer;
        } catch (error) {
            console.error(`Failed to fetch tarball for ${packageName}@${version}:`, error);
            return null;
        }
    }

    async searchPackages(query: string, options: {
        size?: number;
        from?: number;
        quality?: number;
        popularity?: number;
        maintenance?: number;
    } = {}): Promise<{
        objects: Array<{
            package: PackageMetadata;
            score: {
                final: number;
                detail: {
                    quality: number;
                    popularity: number;
                    maintenance: number;
                };
            };
            searchScore: number;
        }>;
        total: number;
        time: string;
    } | null> {
        try {
            const params = new URLSearchParams({
                text: query,
                size: (options.size || 20).toString(),
                from: (options.from || 0).toString(),
            });

            if (options.quality !== undefined) {
                params.append('quality', options.quality.toString());
            }
            if (options.popularity !== undefined) {
                params.append('popularity', options.popularity.toString());
            }
            if (options.maintenance !== undefined) {
                params.append('maintenance', options.maintenance.toString());
            }

            const response = await this.httpClient.get(`/-/v1/search?${params.toString()}`);
            if (response.status !== 200) {
                return null;
            }

            const searchResults = response.data;
            return {
                objects: searchResults.objects.map((obj: any) => ({
                    package: this.convertSearchResultPackage(obj.package),
                    score: obj.score,
                    searchScore: obj.searchScore,
                })),
                total: searchResults.total,
                time: searchResults.time,
            };
        } catch (error) {
            console.error(`Failed to search packages with query "${query}":`, error);
            return null;
        }
    }

    async getDownloadStats(packageName: string, period: 'last-day' | 'last-week' | 'last-month' = 'last-week'): Promise<{
        downloads: number;
        start: string;
        end: string;
        package: string;
    } | null> {
        try {
            const encodedName = encodePackageName(packageName);
            const response = await this.httpClient.get(`https://api.npmjs.org/downloads/point/${period}/${encodedName}`);
            if (response.status !== 200) {
                return null;
            }
            return response.data;
        } catch (error) {
            console.error(`Failed to fetch download stats for ${packageName}:`, error);
            return null;
        }
    }

    async getRegistryStats(): Promise<{
        doc_count: number;
        doc_del_count: number;
        update_seq: number;
        purge_seq: number;
        compact_running: boolean;
        disk_size: number;
        data_size: number;
        instance_start_time: string;
        disk_format_version: number;
    } | null> {
        try {
            const response = await this.httpClient.get('/');
            if (response.status !== 200) {
                return null;
            }
            return response.data;
        } catch (error) {
            console.error('Failed to fetch registry stats:', error);
            return null;
        }
    }

    async getTotalPackageCount(): Promise<number> {
        const names = await this.getKnownPackageNames();
        if (names.length > 0) {
            return names.length;
        }

        const stats = await this.getRegistryStats();
        return stats?.doc_count || 0;
    }

    async getPackages(options: {
        offset?: number;
        limit?: number;
        query?: string;
    } = {}): Promise<{
        packages: PackageMetadata[];
        total: number;
        offset: number;
        limit: number;
    }> {
        const { offset = 0, limit = 100, query } = options;

        try {
            if (query) {
                const searchResult = await this.searchPackages(query, {
                    from: offset,
                    size: limit,
                });

                if (!searchResult) {
                    return { packages: [], total: 0, offset, limit };
                }

                return {
                    packages: searchResult.objects.map(obj => obj.package),
                    total: searchResult.total,
                    offset,
                    limit,
                };
            }

            const knownPackageNames = await this.getKnownPackageNames();
            const page = knownPackageNames.slice(offset, offset + limit).map((packageName) => this.createPackageSummary(packageName));
            return {
                packages: page,
                total: knownPackageNames.length,
                offset,
                limit,
            };
        } catch (error) {
            console.error('Failed to get packages:', error);
            return { packages: [], total: 0, offset, limit };
        }
    }

    async getKnownPackageNames(): Promise<string[]> {
        if (this.knownPackageNames) {
            return this.knownPackageNames;
        }

        try {
            const names = require('all-the-package-names') as string[];
            this.knownPackageNames = Array.isArray(names) ? names : [];
            this.knownPackageNameSet = new Set(this.knownPackageNames);
            return this.knownPackageNames;
        } catch {
            this.knownPackageNames = [];
            this.knownPackageNameSet = new Set<string>();
            return this.knownPackageNames;
        }
    }

    async resolveCanonicalPackageName(nodescopeId: string, packageId: string): Promise<string | null> {
        await this.ensurePackageIdentityMap();
        const fromMap = this.packageIdentityMap?.get(`${nodescopeId}/${packageId}`);
        if (fromMap) {
            return fromMap;
        }

        if (this.knownPackageNames && this.knownPackageNames.length > 0) {
            return null;
        }

        const fallback = nodescopeId === GROUP_CONFIG.UNSCOPED_ID ? packageId : `@${nodescopeId}/${packageId}`;
        return matchesPackageIdentity(fallback, nodescopeId, packageId) ? fallback : null;
    }

    private async fetchPackument(packageName: string) {
        return this.httpClient.get<NpmPackageManifest>(`/${encodePackageName(packageName)}`);
    }

    private convertToPackageMetadata(npmManifest: NpmPackageManifest): PackageMetadata {
        const latestVersion = this.getDefaultVersion(npmManifest);
        const latestVersionData = latestVersion ? npmManifest.versions[latestVersion] : undefined;
        const nodescopeId = getNodescopeId(npmManifest.name);
        const packageId = normalizePackageId(npmManifest.name);
        const parentUrl = `/nodescopes/${nodescopeId}/packages`;

        const packageMetadata: PackageMetadata = {
            ...generateXRegistryEntity({
                id: packageId,
                name: npmManifest.name,
                description: latestVersionData?.description || npmManifest.description || '',
                parentUrl,
                type: 'package',
            }),
            packageid: packageId,
            versions: npmManifest.versions || {},
            time: npmManifest.time || {},
        };

        packageMetadata.createdat = npmManifest.time?.['created'] || (latestVersion ? (npmManifest.time?.[latestVersion] || packageMetadata.createdat) : packageMetadata.createdat);
        packageMetadata.modifiedat = npmManifest.time?.['modified'] || packageMetadata.createdat;

        if (latestVersion) {
            packageMetadata.versionid = normalizeVersionId(latestVersion);
            packageMetadata.version = latestVersion;
            packageMetadata.ancestor = this.computeAncestor(npmManifest, latestVersion);
        }
        if (latestVersionData?.dist) {
            packageMetadata.dist = this.mapDist(latestVersionData.dist);
        }
        if (latestVersionData?.description || npmManifest.description) {
            packageMetadata.description = latestVersionData?.description || npmManifest.description;
        }
        if (latestVersionData?.license || npmManifest.license) {
            packageMetadata.license = latestVersionData?.license || npmManifest.license;
        }
        if (latestVersionData?.author || npmManifest.author) {
            packageMetadata.author = this.parsePerson(latestVersionData?.author || npmManifest.author);
        }
        if (latestVersionData?.homepage || npmManifest.homepage) {
            packageMetadata.homepage = latestVersionData?.homepage || npmManifest.homepage;
        }
        if (latestVersionData?.repository || npmManifest.repository) {
            packageMetadata.repository = this.normalizeObjectField(latestVersionData?.repository || npmManifest.repository);
        }
        if (latestVersionData?.bugs || npmManifest.bugs) {
            packageMetadata.bugs = this.normalizeObjectField(latestVersionData?.bugs || npmManifest.bugs);
        }
        if (latestVersionData?.engines) {
            packageMetadata.engines = latestVersionData.engines;
        }
        if (latestVersionData?.os) {
            packageMetadata.os = [...latestVersionData.os];
        }
        if (latestVersionData?.cpu) {
            packageMetadata.cpu = [...latestVersionData.cpu];
        }
        if (latestVersionData?.keywords || npmManifest.keywords) {
            packageMetadata.keywords = [...(latestVersionData?.keywords || npmManifest.keywords || [])];
        }
        if (npmManifest.maintainers?.length || latestVersionData?.maintainers?.length) {
            packageMetadata.maintainers = (npmManifest.maintainers || latestVersionData?.maintainers || []).map((person) => this.parsePerson(person));
        }
        if (latestVersionData?.contributors?.length || npmManifest.contributors?.length) {
            packageMetadata.contributors = (latestVersionData?.contributors || npmManifest.contributors || []).map((person) => this.parsePerson(person));
        }
        if (npmManifest['dist-tags']) {
            packageMetadata['dist-tags'] = { ...npmManifest['dist-tags'] };
        }
        if (latestVersionData?.deprecated) {
            packageMetadata.deprecated_message = latestVersionData.deprecated;
            packageMetadata.deprecated = {};
        }

        packageMetadata.dependencies = this.mapDependencies(latestVersionData?.dependencies);
        packageMetadata.dev_dependencies = this.mapDependencies(latestVersionData?.devDependencies);
        packageMetadata.peer_dependencies = this.mapDependencies(latestVersionData?.peerDependencies);
        packageMetadata.optional_dependencies = this.mapDependencies(latestVersionData?.optionalDependencies);
        packageMetadata.bundle_dependencies = this.mapBundleDependencies(latestVersionData?.bundleDependencies || latestVersionData?.bundledDependencies);

        const replacedBy = latestVersionData?.replacedBy || latestVersionData?.replacedby || npmManifest.replacedBy || npmManifest.replacedby;
        if (typeof replacedBy === 'string' && replacedBy) {
            packageMetadata.replacedby = toPackageXid(replacedBy);
        }
        if (npmManifest.readme) {
            packageMetadata.readme = npmManifest.readme;
        }
        if (npmManifest.readmeFilename) {
            packageMetadata.readmeFilename = npmManifest.readmeFilename;
        }

        return packageMetadata;
    }

    private convertToVersionMetadata(npmManifest: NpmPackageManifest, npmVersion: NpmVersionManifest): VersionMetadata {
        const nodescopeId = getNodescopeId(npmVersion.name);
        const packageId = normalizePackageId(npmVersion.name);
        const versionId = normalizeVersionId(npmVersion.version);
        const parentUrl = `/nodescopes/${nodescopeId}/packages/${packageId}/versions`;
        const versionMetadata: VersionMetadata = {
            ...generateXRegistryEntity({
                id: versionId,
                name: npmVersion.name,
                description: npmVersion.description || npmManifest.description || '',
                parentUrl,
                type: 'version',
            }),
            packageid: packageId,
            versionid: versionId,
            version: npmVersion.version,
            ancestor: this.computeAncestor(npmManifest, npmVersion.version),
            dist: this.mapDist(npmVersion.dist),
            name: npmVersion.name,
        };

        const publishedAt = npmManifest.time?.[npmVersion.version];
        if (publishedAt) {
            versionMetadata.createdat = publishedAt;
            versionMetadata.modifiedat = publishedAt;
        }
        if (npmVersion.license) {
            versionMetadata.license = npmVersion.license;
        }
        if (npmVersion.author) {
            versionMetadata.author = this.parsePerson(npmVersion.author);
        }
        if (npmVersion.homepage) {
            versionMetadata.homepage = npmVersion.homepage;
        }
        if (npmVersion.repository) {
            versionMetadata.repository = this.normalizeObjectField(npmVersion.repository);
        }
        if (npmVersion.bugs) {
            versionMetadata.bugs = this.normalizeObjectField(npmVersion.bugs);
        }
        if (npmVersion.engines) {
            versionMetadata.engines = npmVersion.engines;
        }
        if (npmVersion.os) {
            versionMetadata.os = [...npmVersion.os];
        }
        if (npmVersion.cpu) {
            versionMetadata.cpu = [...npmVersion.cpu];
        }
        if (npmVersion.keywords) {
            versionMetadata.keywords = [...npmVersion.keywords];
        }
        if (npmVersion.maintainers?.length || npmManifest.maintainers?.length) {
            versionMetadata.maintainers = (npmVersion.maintainers || npmManifest.maintainers || []).map((person) => this.parsePerson(person));
        }
        if (npmVersion.contributors?.length || npmManifest.contributors?.length) {
            versionMetadata.contributors = (npmVersion.contributors || npmManifest.contributors || []).map((person) => this.parsePerson(person));
        }
        if (npmManifest['dist-tags']) {
            versionMetadata['dist-tags'] = { ...npmManifest['dist-tags'] };
        }
        if (npmVersion.deprecated) {
            versionMetadata.deprecated_message = npmVersion.deprecated;
            versionMetadata.deprecated = {};
        }

        versionMetadata.dependencies = this.mapDependencies(npmVersion.dependencies);
        versionMetadata.dev_dependencies = this.mapDependencies(npmVersion.devDependencies);
        versionMetadata.peer_dependencies = this.mapDependencies(npmVersion.peerDependencies);
        versionMetadata.optional_dependencies = this.mapDependencies(npmVersion.optionalDependencies);
        versionMetadata.bundle_dependencies = this.mapBundleDependencies(npmVersion.bundleDependencies || npmVersion.bundledDependencies);

        const replacedBy = npmVersion.replacedBy || npmVersion.replacedby || npmManifest.replacedBy || npmManifest.replacedby;
        if (typeof replacedBy === 'string' && replacedBy) {
            versionMetadata.replacedby = toPackageXid(replacedBy);
        }

        return versionMetadata;
    }

    private convertSearchResultPackage(searchPackage: SearchPackageResult): PackageMetadata {
        const nodescopeId = getNodescopeId(searchPackage.name);
        const packageId = normalizePackageId(searchPackage.name);
        const publishedAt = searchPackage.date || new Date().toISOString();
        const packageMetadata: PackageMetadata = {
            ...generateXRegistryEntity({
                id: packageId,
                name: searchPackage.name,
                description: searchPackage.description || '',
                parentUrl: `/nodescopes/${nodescopeId}/packages`,
                type: 'package',
            }),
            packageid: packageId,
            versions: {},
            time: {},
        };

        packageMetadata.createdat = publishedAt;
        packageMetadata.modifiedat = publishedAt;
        if (searchPackage.version) {
            packageMetadata.version = searchPackage.version;
            packageMetadata.versionid = normalizeVersionId(searchPackage.version);
            packageMetadata.ancestor = normalizeVersionId(searchPackage.version);
        }
        if (searchPackage.keywords?.length) {
            packageMetadata.keywords = [...searchPackage.keywords];
        }
        if (searchPackage.author) {
            packageMetadata.author = this.parsePerson(searchPackage.author);
        }
        if (searchPackage.maintainers?.length) {
            packageMetadata.maintainers = searchPackage.maintainers.map((maintainer) => this.parsePerson({
                name: maintainer.name || maintainer.username,
                email: maintainer.email,
                url: maintainer.url,
            }));
        }

        return packageMetadata;
    }

    private createPackageSummary(packageName: string): PackageMetadata {
        const nodescopeId = getNodescopeId(packageName);
        const packageId = normalizePackageId(packageName);
        const summary: PackageMetadata = {
            ...generateXRegistryEntity({
                id: packageId,
                name: packageName,
                parentUrl: `/nodescopes/${nodescopeId}/packages`,
                type: 'package',
            }),
            packageid: packageId,
            versions: {},
            time: {},
        };
        return summary;
    }

    private getDefaultVersion(npmManifest: NpmPackageManifest): string | undefined {
        return npmManifest['dist-tags']?.['latest'] || Object.keys(npmManifest.versions || {})[0];
    }

    private computeAncestor(npmManifest: NpmPackageManifest, version: string): string {
        const time = npmManifest.time || {};
        const orderedVersions = Object.keys(npmManifest.versions || {})
            .filter((candidate) => typeof time[candidate] === 'string')
            .sort((left, right) => Date.parse(time[left] || '') - Date.parse(time[right] || ''));

        if (orderedVersions.length === 0) {
            return normalizeVersionId(version);
        }

        const index = orderedVersions.indexOf(version);
        if (index <= 0) {
            return normalizeVersionId(version);
        }

        return normalizeVersionId(orderedVersions[index - 1] || version);
    }

    private mapDist(dist: NpmVersionManifest['dist']): DistMetadata {
        const result: DistMetadata = {
            tarball: dist.tarball,
        };

        if (dist.shasum) {
            result.shasum = dist.shasum;
        }
        if (dist.integrity) {
            result.integrity = dist.integrity;
        }
        if (dist.fileCount !== undefined) {
            result.file_count = dist.fileCount;
        }
        if (dist.unpackedSize !== undefined) {
            result.unpacked_size = dist.unpackedSize;
        }
        if (dist['npm-signature']) {
            result['npm-signature'] = dist['npm-signature'];
        }

        return result;
    }

    private mapDependencies(source?: Record<string, string>): DependencyReference[] | undefined {
        if (!source || Object.keys(source).length === 0) {
            return undefined;
        }

        return Object.entries(source).map(([name, version]) => {
            const entry: DependencyReference = { name, version };
            const packageXid = this.resolvePackageXid(name);
            if (packageXid) {
                entry.package = packageXid;
            }
            return entry;
        });
    }

    private mapBundleDependencies(source?: string[]): BundleDependencyReference[] | undefined {
        if (!source || source.length === 0) {
            return undefined;
        }

        return source.map((name) => {
            const entry: BundleDependencyReference = { name };
            const packageXid = this.resolvePackageXid(name);
            if (packageXid) {
                entry.package = packageXid;
            }
            return entry;
        });
    }

    private resolvePackageXid(packageName: string): string | undefined {
        if (!isValidPackageName(packageName)) {
            return undefined;
        }
        if (this.knownPackageNameSet && !this.knownPackageNameSet.has(packageName)) {
            return undefined;
        }
        return toPackageXid(packageName);
    }

    private parsePerson(person?: NpmPerson): Person {
        if (!person) {
            return {};
        }

        if (typeof person === 'string') {
            const match = person.match(/^\s*([^<(]+?)?\s*(?:<([^>]+)>)?\s*(?:\(([^)]+)\))?\s*$/);
            if (!match) {
                return { name: person.trim() };
            }

            const parsed: Person = {};
            if (match[1]?.trim()) {
                parsed.name = match[1].trim();
            }
            if (match[2]?.trim()) {
                parsed.email = match[2].trim();
            }
            if (match[3]?.trim()) {
                parsed.url = match[3].trim();
            }
            return parsed;
        }

        return {
            ...(person.name ? { name: person.name } : {}),
            ...(person.email ? { email: person.email } : {}),
            ...(person.url ? { url: person.url } : {}),
        };
    }

    private normalizeObjectField(field?: NpmObjectField): Record<string, unknown> | undefined {
        if (!field) {
            return undefined;
        }
        if (typeof field === 'string') {
            return { url: field };
        }
        return field;
    }

    private async ensurePackageIdentityMap(): Promise<void> {
        if (this.packageIdentityMap) {
            return;
        }

        const knownPackageNames = await this.getKnownPackageNames();
        this.packageIdentityMap = new Map<string, string>();
        for (const packageName of knownPackageNames) {
            this.packageIdentityMap.set(`${getNodescopeId(packageName)}/${normalizePackageId(packageName)}`, packageName);
        }
    }
}
