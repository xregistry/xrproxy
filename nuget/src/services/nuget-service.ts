import axios, { AxiosInstance, AxiosResponse } from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { EntityStateManager } from '../../../shared/entity-state-manager';
import { CacheManager } from '../cache/cache-manager';
import { CACHE_CONFIG, GROUP_CONFIG, NUGET_REGISTRY, RESOURCE_CONFIG } from '../config/constants';
import { CachedResponse, CacheMetadata, NuGetCatalogEntry, NuGetCatalogIndex, NuGetCatalogPage, NuGetDependencyGroup, NuGetPackageSearchResult, NuGetRegistrationIndex, NuGetRegistrationPage, NuGetRepositorySignatures, NuGetSearchResponse, NuGetServiceIndex, NuGetVulnerability } from '../types/nuget';
import { Group, Meta, PackageDependency, PackageMetadata, PackageRepository, PackageType, PackageVulnerability, RepositorySigningCertificate, VersionMetadata } from '../types/xregistry';

const SHA256_FINGERPRINT_OID = '2.16.840.1.101.3.4.2.1';

export interface NuGetServiceConfig {
    searchUrl?: string; registrationBaseUrl?: string; catalogIndexUrl?: string; serviceIndexUrl?: string; flatContainerUrl?: string; timeout?: number; userAgent?: string; cacheManager?: CacheManager; cacheTtl?: number; cacheDir?: string; entityState?: EntityStateManager;
}
interface PackageProjectionContext { packageid: string; resourcePath: string; resourceSelf: string; defaultEntry: NuGetCatalogEntry; defaultVersionId: string; ancestor: string; versions: NuGetCatalogEntry[]; searchResult: NuGetPackageSearchResult; }

export class NuGetService {
    private readonly httpClient: AxiosInstance;
    private readonly cacheDir: string;
    private readonly searchUrl: string;
    private readonly registrationBaseUrl: string;
    private readonly catalogIndexUrl: string;
    private readonly serviceIndexUrl: string;
    private readonly flatContainerUrl: string;
    private readonly entityState: EntityStateManager;
    private packageNamesCache: string[] = [];
    private catalogCursor: string | null = null;

    constructor(config: NuGetServiceConfig = {}) {
        this.searchUrl = config.searchUrl || NUGET_REGISTRY.SEARCH_URL;
        this.registrationBaseUrl = config.registrationBaseUrl || NUGET_REGISTRY.REGISTRATION_BASE_URL;
        this.catalogIndexUrl = config.catalogIndexUrl || NUGET_REGISTRY.CATALOG_INDEX_URL;
        this.serviceIndexUrl = config.serviceIndexUrl || NUGET_REGISTRY.SERVICE_INDEX_URL;
        this.flatContainerUrl = config.flatContainerUrl || NUGET_REGISTRY.FLAT_CONTAINER_URL;
        this.cacheDir = config.cacheDir || CACHE_CONFIG.CACHE_DIR;
        this.entityState = config.entityState || new EntityStateManager();
        this.httpClient = axios.create({ timeout: config.timeout || NUGET_REGISTRY.TIMEOUT_MS, headers: { 'User-Agent': config.userAgent || NUGET_REGISTRY.USER_AGENT, Accept: 'application/json' } });
        if (!fs.existsSync(this.cacheDir)) fs.mkdirSync(this.cacheDir, { recursive: true });
        this.loadCacheMetadata();
    }

    static normalizePackageId(packageId: string): string { return packageId.toLowerCase(); }
    static toVersionId(version: string): string { return version.replace(/\+/g, '~'); }
    static fromVersionId(versionId: string): string { return versionId.replace(/~/g, '+'); }

    private async cachedGet<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
        const cacheFile = path.join(this.cacheDir, Buffer.from(url).toString('base64').replace(/[\\/+=]/g, '_'));
        let etag: string | null = null;
        let cachedData: T | null = null;
        if (fs.existsSync(cacheFile)) {
            try { const cached: CachedResponse<T> = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); etag = cached.etag; cachedData = cached.data; } catch { cachedData = null; }
        }
        const requestHeaders = { ...headers };
        if (etag) requestHeaders['If-None-Match'] = etag;
        try {
            const response: AxiosResponse<T> = await this.httpClient.get(url, { headers: requestHeaders, validateStatus: (status) => status < 500 });
            if (response.status === 200) { fs.writeFileSync(cacheFile, JSON.stringify({ etag: response.headers['etag'] || null, data: response.data, timestamp: Date.now() } satisfies CachedResponse<T>)); return response.data; }
            if (response.status === 304 && cachedData) return cachedData;
        } catch (error: unknown) {
            if (axios.isAxiosError(error) && cachedData && (error.code === 'ECONNABORTED' || error.code === 'ENOTFOUND' || error.code === 'ETIMEDOUT')) return cachedData;
            if (cachedData) return cachedData;
            throw error;
        }
        if (cachedData) return cachedData;
        throw new Error(`Failed to fetch ${url}`);
    }

    async searchPackages(query: string, prerelease: boolean = false, take: number = 50, skip: number = 0): Promise<NuGetPackageSearchResult[]> {
        const response = await this.getSearchResponse(query, take, skip, prerelease);
        return response.data || [];
    }

    async getSearchResponse(query: string, take: number, skip: number = 0, prerelease: boolean = false): Promise<NuGetSearchResponse> {
        const searchUrl = `${this.searchUrl}?q=${encodeURIComponent(query)}&prerelease=${prerelease}&skip=${skip}&take=${take}`;
        return this.cachedGet<NuGetSearchResponse>(searchUrl);
    }
    async fetchNuGetPackageData(packageId: string): Promise<NuGetPackageSearchResult> {
        const canonicalPackageId = NuGetService.normalizePackageId(packageId);
        const response = await this.getSearchResponse(`PackageId:${canonicalPackageId}`, 20);
        const packageData = response.data.find((p) => NuGetService.normalizePackageId(p.id) === canonicalPackageId);
        if (!packageData) throw new Error(`Package not found: ${packageId}`);
        return packageData;
    }

    async fetchNuGetPackageRegistration(packageId: string): Promise<NuGetCatalogEntry[]> {
        const registrationUrl = `${this.registrationBaseUrl}/${NuGetService.normalizePackageId(packageId)}/index.json`;
        const registrationIndex = await this.cachedGet<NuGetRegistrationIndex>(registrationUrl);
        const allEntries: NuGetCatalogEntry[] = [];
        for (const page of registrationIndex.items || []) {
            let pageItems = page.items;
            if (!pageItems && page['@id']) {
                const pageData = await this.cachedGet<NuGetRegistrationPage>(page['@id']);
                pageItems = pageData.items;
            }
            for (const item of pageItems || []) {
                const mergedEntry = item.packageContent ? { ...item.catalogEntry, packageContent: item.packageContent } : item.catalogEntry;
                allEntries.push(mergedEntry);
            }
        }
        if (allEntries.length === 0) throw new Error(`No version information found for package ${packageId}`);
        return allEntries;
    }

    async getServiceIndex(): Promise<NuGetServiceIndex> { return this.cachedGet<NuGetServiceIndex>(this.serviceIndexUrl); }

    async getRepositorySignatures(): Promise<NuGetRepositorySignatures | null> {
        const index = await this.getServiceIndex();
        const resource = (index.resources || []).find((candidate) => {
            const types = Array.isArray(candidate['@type']) ? candidate['@type'] : [candidate['@type']];
            return types.some((value) => value.includes('RepositorySignatures'));
        });
        return resource ? this.cachedGet<NuGetRepositorySignatures>(resource['@id']) : null;
    }

    getLatestStableVersion(entries: NuGetCatalogEntry[]): NuGetCatalogEntry | null {
        const stableEntries = entries.filter((entry) => entry.version && !entry.version.includes('-'));
        const candidates = stableEntries.length > 0 ? stableEntries : entries;
        return candidates.sort((a, b) => this.compareVersions(b.version, a.version))[0] || null;
    }

    private compareVersions(v1: string, v2: string): number {
        const parts1 = v1.split(/[.-]/).map((p) => Number.isNaN(parseInt(p, 10)) ? p : parseInt(p, 10));
        const parts2 = v2.split(/[.-]/).map((p) => Number.isNaN(parseInt(p, 10)) ? p : parseInt(p, 10));
        for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
            const p1 = parts1[i] || 0; const p2 = parts2[i] || 0;
            if (typeof p1 === 'number' && typeof p2 === 'number') { if (p1 > p2) return 1; if (p1 < p2) return -1; }
            else { const s1 = String(p1); const s2 = String(p2); if (s1 > s2) return 1; if (s1 < s2) return -1; }
        }
        return 0;
    }

    async packageExists(packageId: string): Promise<boolean> { try { await this.fetchNuGetPackageData(packageId); return true; } catch { return false; } }
    async versionExists(packageId: string, version: string): Promise<boolean> { try { return (await this.fetchNuGetPackageRegistration(packageId)).some((entry) => NuGetService.toVersionId(entry.version) === version); } catch { return false; } }
    private isPackageInCache(packageId: string): boolean { const canonical = NuGetService.normalizePackageId(packageId); return this.packageNamesCache.some((name) => NuGetService.normalizePackageId(name) === canonical); }
    private addPackageToCache(packageId: string): void { if (!this.isPackageInCache(packageId)) { this.packageNamesCache.push(packageId); this.saveCacheMetadata(); } }

    private loadCacheMetadata(): void {
        const metadataFile = path.join(this.cacheDir, 'cache-metadata.json');
        if (fs.existsSync(metadataFile)) {
            try { const metadata: CacheMetadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8')); this.catalogCursor = metadata.catalogCursor; this.packageNamesCache = metadata.packageNames || []; } catch { this.packageNamesCache = []; }
        }
    }

    private saveCacheMetadata(): void {
        const metadata: CacheMetadata = { catalogCursor: this.catalogCursor, lastUpdate: new Date().toISOString(), packageNames: this.packageNamesCache };
        fs.writeFileSync(path.join(this.cacheDir, 'cache-metadata.json'), JSON.stringify(metadata, null, 2));
    }

    getPackageNamesCache(): string[] { return [...this.packageNamesCache]; }

    async getTotalPackageCount(): Promise<number> {
        try { const response = await this.getSearchResponse('', 0, 0); return response.totalHits ?? this.packageNamesCache.length; }
        catch { return this.packageNamesCache.length; }
    }

    async getPackages(options: { offset: number; limit: number; query?: string }): Promise<{ packages: string[]; total: number }> {
        const response = await this.getSearchResponse(options.query || '', options.limit, options.offset);
        return { packages: (response.data || []).map((pkg) => pkg.id), total: response.totalHits ?? response.data.length };
    }

    async refreshPackageNamesFromCatalog(): Promise<void> {
        try {
            const catalogIndex = await this.cachedGet<NuGetCatalogIndex>(this.catalogIndexUrl);
            for (const page of catalogIndex.items) await this.processCatalogPage(page['@id'], this.catalogCursor);
            this.catalogCursor = catalogIndex.commitTimeStamp || null;
            this.saveCacheMetadata();
        } catch { }
    }

    private async processCatalogPage(pageUrl: string, cursor: string | null): Promise<void> {
        const page = await this.cachedGet<NuGetCatalogPage>(pageUrl);
        for (const item of page.items || []) {
            if (cursor && item.commitTimeStamp <= cursor) continue;
            const packageId = item['nuget:id'];
            if (packageId) this.addPackageToCache(packageId);
        }
    }
    private buildGroupPaths(baseUrl: string): { groupPath: string; groupSelf: string } {
        const groupPath = `/${GROUP_CONFIG.TYPE}/${GROUP_CONFIG.ID}`;
        return { groupPath, groupSelf: `${baseUrl}${groupPath}` };
    }

    private buildPackagePaths(baseUrl: string, packageid: string): { resourcePath: string; resourceSelf: string; metaPath: string; versionsPath: string } {
        const resourcePath = `/${GROUP_CONFIG.TYPE}/${GROUP_CONFIG.ID}/${RESOURCE_CONFIG.TYPE}/${packageid}`;
        return { resourcePath, resourceSelf: `${baseUrl}${resourcePath}`, metaPath: `${resourcePath}/meta`, versionsPath: `${resourcePath}/versions` };
    }

    private sortEntriesByVersion(entries: NuGetCatalogEntry[]): NuGetCatalogEntry[] { return [...entries].sort((a, b) => this.compareVersions(a.version, b.version)); }
    private selectDefaultEntry(entries: NuGetCatalogEntry[], searchResult: NuGetPackageSearchResult): NuGetCatalogEntry { return entries.find((entry) => entry.version === searchResult.version) || this.getLatestStableVersion(entries) || entries[entries.length - 1]!; }
    private isUnlistedSentinel(published?: string): boolean { if (!published) return false; const parsed = new Date(published); return !Number.isNaN(parsed.getTime()) && parsed.getUTCFullYear() === 1900; }

    private buildCreatedAt(pathId: string, published?: string): string {
        if (published && !this.isUnlistedSentinel(published)) { const parsed = new Date(published); if (!Number.isNaN(parsed.getTime())) return parsed.toISOString(); }
        return this.entityState.getCreatedAt(pathId);
    }

    private buildModifiedAt(pathId: string, published?: string): string {
        if (published && !this.isUnlistedSentinel(published)) { const parsed = new Date(published); if (!Number.isNaN(parsed.getTime())) return parsed.toISOString(); }
        return this.entityState.getModifiedAt(pathId);
    }

    private normalizeAuthors(value?: string | string[]): string[] | undefined { if (Array.isArray(value)) return value.length > 0 ? value : undefined; if (typeof value === 'string' && value.length > 0) return [value]; return undefined; }
    private normalizeTags(value?: string | string[]): string[] | undefined { if (Array.isArray(value)) return value.length > 0 ? value : undefined; if (typeof value === 'string' && value.trim().length > 0) { const tags = value.split(/\s+/).filter(Boolean); return tags.length > 0 ? tags : undefined; } return undefined; }
    private normalizeOwners(value?: string | string[]): string[] | undefined { if (Array.isArray(value)) return value.length > 0 ? value : undefined; if (typeof value === 'string' && value.trim().length > 0) { const owners = value.split(',').map((entry) => entry.trim()).filter(Boolean); return owners.length > 0 ? owners : undefined; } return undefined; }
    private normalizePackageTypes(packageTypes?: PackageType[]): PackageType[] | undefined { return packageTypes && packageTypes.length > 0 ? packageTypes.map((pkgType) => ({ name: pkgType.name, ...(pkgType.version ? { version: pkgType.version } : {}) })) : undefined; }

    private normalizeRepository(repository?: PackageRepository): PackageRepository | undefined {
        if (!repository) return undefined;
        const normalized: PackageRepository = {};
        if (repository.type) normalized.type = repository.type;
        if (repository.url) normalized.url = repository.url;
        if (repository.branch) normalized.branch = repository.branch;
        if (repository.commit) normalized.commit = repository.commit;
        return Object.keys(normalized).length > 0 ? normalized : undefined;
    }

    private normalizeVulnerabilities(vulnerabilities?: NuGetVulnerability[]): PackageVulnerability[] | undefined {
        if (vulnerabilities === undefined) return undefined;
        return vulnerabilities.map((item) => ({ ...(item.advisoryUrl ? { advisory_url: item.advisoryUrl } : {}), ...(item.severity !== undefined ? { severity: typeof item.severity === 'string' ? parseInt(item.severity, 10) : item.severity } : {}) }));
    }

    private normalizePackageContent(entry: NuGetCatalogEntry): string {
        if (entry.packageContent) return entry.packageContent;
        const lowerId = NuGetService.normalizePackageId(entry.id); const lowerVersion = entry.version.toLowerCase();
        return `${this.flatContainerUrl}/${lowerId}/${lowerVersion}/${lowerId}.${lowerVersion}.nupkg`;
    }

    private inferListed(entry: NuGetCatalogEntry): boolean | undefined { if (entry.listed !== undefined) return entry.listed; if (entry.published) return !this.isUnlistedSentinel(entry.published); return undefined; }
    private maybeResolvedVersion(range?: string): string | undefined { return range ? range.match(/^\[([^,\]]+)\]$/)?.[1] : undefined; }
    private buildDependencyLink(packageId: string): string { return `/${GROUP_CONFIG.TYPE}/${GROUP_CONFIG.ID}/${RESOURCE_CONFIG.TYPE}/${NuGetService.normalizePackageId(packageId)}`; }

    private flattenDependencies(dependencyGroups?: NuGetDependencyGroup[]): PackageDependency[] | undefined {
        if (!dependencyGroups || dependencyGroups.length === 0) return undefined;
        const dependencies: PackageDependency[] = [];
        for (const group of dependencyGroups) {
            for (const dependency of group.dependencies || []) {
                const resolved = this.maybeResolvedVersion(dependency.range);
                dependencies.push({ name: dependency.id, ...(dependency.range ? { range: dependency.range } : {}), target_framework: group.targetFramework && group.targetFramework.trim().length > 0 ? group.targetFramework : 'any', package: this.buildDependencyLink(dependency.id), ...(resolved ? { resolved_version: resolved } : {}) });
            }
        }
        return dependencies.length > 0 ? dependencies : undefined;
    }

    private buildDeprecation(entry: NuGetCatalogEntry): PackageMetadata['deprecation'] | undefined {
        if (!entry.deprecation) return undefined;
        const projected: NonNullable<PackageMetadata['deprecation']> = {};
        if (entry.deprecation.reasons && entry.deprecation.reasons.length > 0) projected.reasons = [...entry.deprecation.reasons];
        if (entry.deprecation.message) projected.message = entry.deprecation.message;
        if (entry.deprecation.alternatePackage) {
            const alternate: NonNullable<NonNullable<PackageMetadata['deprecation']>['alternate_package']> = {};
            if (entry.deprecation.alternatePackage.id) { alternate.id = entry.deprecation.alternatePackage.id; alternate.package = this.buildDependencyLink(entry.deprecation.alternatePackage.id); }
            if (entry.deprecation.alternatePackage.range) alternate.range = entry.deprecation.alternatePackage.range;
            if (Object.keys(alternate).length > 0) projected.alternate_package = alternate;
        }
        return Object.keys(projected).length > 0 ? projected : undefined;
    }
    private buildVersionAttributes(entry: NuGetCatalogEntry, searchResult: NuGetPackageSearchResult): Omit<VersionMetadata, 'xid' | 'self' | 'epoch' | 'createdat' | 'modifiedat' | 'versionid' | 'ancestor'> {
        const authors = this.normalizeAuthors(entry.authors);
        const tags = this.normalizeTags(entry.tags);
        const packageTypes = this.normalizePackageTypes(entry.packageTypes || searchResult.packageTypes);
        const repository = this.normalizeRepository(entry.repository);
        const vulnerabilities = this.normalizeVulnerabilities(entry.vulnerabilities);
        const deprecation = this.buildDeprecation(entry);
        const dependencies = this.flattenDependencies(entry.dependencyGroups);
        const listed = this.inferListed(entry);
        return {
            packageid: NuGetService.normalizePackageId(entry.id), name: entry.id, ...(entry.description ? { description: entry.description } : {}), version: entry.version, ...(entry.title ? { title: entry.title } : {}), ...(authors ? { authors } : {}), ...(entry.summary ? { summary: entry.summary } : {}), ...(entry.language ? { language: entry.language } : {}), ...(entry.iconUrl ? { icon_url: entry.iconUrl } : {}), ...(entry.readmeUrl ? { readme_url: entry.readmeUrl } : {}), ...(entry.licenseUrl ? { license_url: entry.licenseUrl } : {}), ...(entry.licenseExpression ? { license_expression: entry.licenseExpression } : {}), ...(entry.requireLicenseAcceptance !== undefined ? { require_license_acceptance: entry.requireLicenseAcceptance } : {}), ...(entry.projectUrl ? { project_url: entry.projectUrl } : {}), package_content: this.normalizePackageContent(entry), ...(entry.minClientVersion ? { min_client_version: entry.minClientVersion } : {}), ...(listed !== undefined ? { listed } : {}), ...(entry.published ? { published: entry.published } : {}), ...(tags ? { tags } : {}), ...(packageTypes ? { package_types: packageTypes } : {}), ...(repository ? { repository } : {}), ...(deprecation ? { deprecation } : {}), ...(vulnerabilities !== undefined ? { vulnerabilities } : {}), ...(dependencies ? { dependencies } : {}),
        };
    }

    private buildProjectionContext(baseUrl: string, searchResult: NuGetPackageSearchResult, entries: NuGetCatalogEntry[]): PackageProjectionContext {
        const sortedByVersion = this.sortEntriesByVersion(entries);
        const defaultEntry = this.selectDefaultEntry(sortedByVersion, searchResult);
        const defaultIndex = sortedByVersion.findIndex((entry) => entry.version === defaultEntry.version);
        const ancestorEntry = defaultIndex > 0 ? sortedByVersion[defaultIndex - 1]! : defaultEntry;
        const packageid = NuGetService.normalizePackageId(defaultEntry.id);
        const { resourcePath, resourceSelf } = this.buildPackagePaths(baseUrl, packageid);
        return { packageid, resourcePath, resourceSelf, defaultEntry, defaultVersionId: NuGetService.toVersionId(defaultEntry.version), ancestor: NuGetService.toVersionId(ancestorEntry.version), versions: sortedByVersion, searchResult };
    }

    private buildVersionEntity(entry: NuGetCatalogEntry, context: PackageProjectionContext, baseUrl: string, ancestor: string): VersionMetadata {
        const versionId = NuGetService.toVersionId(entry.version);
        const versionPath = `${context.resourcePath}/versions/${versionId}`;
        return { ...this.buildVersionAttributes(entry, context.searchResult), versionid: versionId, ancestor, xid: versionPath, self: `${baseUrl}${versionPath}`, epoch: this.entityState.getEpoch(versionPath), createdat: this.buildCreatedAt(versionPath, entry.published), modifiedat: this.buildModifiedAt(versionPath, entry.published) };
    }

    async getPackageMetadata(packageName: string, baseUrl: string = ''): Promise<PackageMetadata | null> {
        try {
            const packageData = await this.fetchNuGetPackageData(packageName);
            const entries = await this.fetchNuGetPackageRegistration(packageName);
            const context = this.buildProjectionContext(baseUrl, packageData, entries);
            const defaultVersion = this.buildVersionEntity(context.defaultEntry, context, baseUrl, context.ancestor);
            const { metaPath, versionsPath } = this.buildPackagePaths(baseUrl, context.packageid);
            return { ...defaultVersion, xid: context.resourcePath, self: context.resourceSelf, packageid: context.packageid, versionid: context.defaultVersionId, ancestor: context.ancestor, metaurl: `${baseUrl}${metaPath}`, versionsurl: `${baseUrl}${versionsPath}`, versionscount: context.versions.length };
        } catch { return null; }
    }

    async getPackageVersions(packageName: string, baseUrl: string = ''): Promise<Record<string, VersionMetadata> | null> {
        try {
            const searchResult = await this.fetchNuGetPackageData(packageName);
            const entries = await this.fetchNuGetPackageRegistration(packageName);
            const context = this.buildProjectionContext(baseUrl, searchResult, entries);
            const versions: Record<string, VersionMetadata> = {};
            context.versions.forEach((entry, index) => {
                const ancestorEntry = index > 0 ? context.versions[index - 1]! : entry;
                const version = this.buildVersionEntity(entry, context, baseUrl, NuGetService.toVersionId(ancestorEntry.version));
                versions[version.versionid] = version;
            });
            return versions;
        } catch { return null; }
    }

    async getVersionMetadata(packageName: string, versionId: string, baseUrl: string = ''): Promise<VersionMetadata | null> {
        try {
            const searchResult = await this.fetchNuGetPackageData(packageName);
            const entries = await this.fetchNuGetPackageRegistration(packageName);
            const context = this.buildProjectionContext(baseUrl, searchResult, entries);
            const upstreamVersion = NuGetService.fromVersionId(versionId);
            const index = context.versions.findIndex((entry) => entry.version === upstreamVersion);
            if (index < 0) return null;
            const entry = context.versions[index]!;
            const ancestorEntry = index > 0 ? context.versions[index - 1]! : entry;
            return this.buildVersionEntity(entry, context, baseUrl, NuGetService.toVersionId(ancestorEntry.version));
        } catch { return null; }
    }

    async getPackageMeta(packageName: string, baseUrl: string = ''): Promise<Meta | null> {
        try {
            const searchResult = await this.fetchNuGetPackageData(packageName);
            const entries = await this.fetchNuGetPackageRegistration(packageName);
            const context = this.buildProjectionContext(baseUrl, searchResult, entries);
            const { metaPath } = this.buildPackagePaths(baseUrl, context.packageid);
            const owners = this.normalizeOwners(searchResult.owners);
            return { packageid: context.packageid, xid: metaPath, self: `${baseUrl}${metaPath}`, epoch: this.entityState.getEpoch(metaPath), createdat: this.entityState.getCreatedAt(metaPath), modifiedat: this.entityState.getModifiedAt(metaPath), defaultversionid: context.defaultVersionId, defaultversionurl: `${context.resourceSelf}/versions/${encodeURIComponent(context.defaultVersionId)}`, defaultversionsticky: false, ...(owners ? { owners } : {}), ...(searchResult.totalDownloads !== undefined ? { total_downloads: searchResult.totalDownloads } : {}), ...(searchResult.verified !== undefined ? { verified: searchResult.verified } : {}) };
        } catch { return null; }
    }
    async getGroup(baseUrl: string, includePackages: boolean = false, packageOptions?: { query?: string; offset?: number; limit?: number }): Promise<Group> {
        const { groupPath, groupSelf } = this.buildGroupPaths(baseUrl);
        const totalCount = await this.getTotalPackageCount();
        const repositorySignatures = await this.getRepositorySignatures().catch(() => null);
        const projectedCertificates: RepositorySigningCertificate[] | undefined = repositorySignatures?.signingCertificates?.map((certificate) => ({ ...(certificate.subject ? { subject: certificate.subject } : {}), ...(certificate.issuer ? { issuer: certificate.issuer } : {}), ...(certificate.fingerprints?.[SHA256_FINGERPRINT_OID] ? { fingerprint_sha256: certificate.fingerprints[SHA256_FINGERPRINT_OID].toLowerCase() } : {}), ...(certificate.notBefore ? { not_before: certificate.notBefore } : {}), ...(certificate.notAfter ? { not_after: certificate.notAfter } : {}), ...(certificate.contentUrl ? { content_url: certificate.contentUrl } : {}) }));
        const group: Group = { dotnetregistryid: GROUP_CONFIG.ID, xid: groupPath, self: groupSelf, epoch: this.entityState.getEpoch(groupPath), createdat: this.entityState.getCreatedAt(groupPath), modifiedat: this.entityState.getModifiedAt(groupPath), sourceurl: GROUP_CONFIG.SOURCE_URL, ...(repositorySignatures?.allRepositorySigned !== undefined ? { all_repository_signed: repositorySignatures.allRepositorySigned } : {}), ...(projectedCertificates && projectedCertificates.length > 0 ? { repository_signing_certificates: projectedCertificates } : {}), packagesurl: `${groupSelf}/${RESOURCE_CONFIG.TYPE}`, packagescount: totalCount };
        if (includePackages) group.packages = (await this.searchPackageResources(baseUrl, packageOptions || {})).packages;
        return group;
    }

    async searchPackageResources(baseUrl: string, options: { query?: string; offset?: number; limit?: number } = {}): Promise<{ packages: Record<string, PackageMetadata>; totalCount: number }> {
        const offset = options.offset ?? 0; const limit = options.limit ?? 20;
        const response = await this.getSearchResponse(options.query || '', limit, offset);
        const projected = await Promise.all((response.data || []).map((result) => this.getPackageMetadata(result.id, baseUrl)));
        const packages: Record<string, PackageMetadata> = {};
        projected.forEach((resource) => { if (resource) packages[resource.packageid] = resource; });
        return { packages, totalCount: response.totalHits ?? Object.keys(packages).length };
    }
}
