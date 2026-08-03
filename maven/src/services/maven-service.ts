/**
 * Maven Service
 * @fileoverview Service for interacting with Maven Central APIs and projecting Maven metadata.
 */

import axios, { AxiosInstance } from 'axios';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as path from 'path';
import { promisify } from 'util';
import { ParserOptions, parseString } from 'xml2js';
import { CACHE_CONFIG, MAX_SOLR_ROWS, MAVEN_REGISTRY } from '../config/constants';
import {
    CachedPackageMetadata,
    MavenArtifactDoc,
    MavenArtifactMetadata,
    MavenChecksum,
    MavenDependency,
    MavenDeveloper,
    MavenIssueManagement,
    MavenLicense,
    MavenParentReference,
    MavenProfile,
    MavenResolvedVersion,
    MavenScm,
    MavenSearchResponse,
    MavenSignature
} from '../types/maven';
import {
    buildHashedEntityId,
    buildNamespaceIdMap,
    buildPackageIdMap,
    isHashedIdentity,
    toVersionId
} from '../utils/maven-identity';

const parseXml: (xml: string, options: ParserOptions) => Promise<any> = promisify(parseString);
const FACET_BATCH_SIZE = 500;

type PublishedFile = {
    filename: string;
    classifier?: string;
    extension: string;
    url: string;
};

function asArray<T>(value: T | T[] | undefined): T[] {
    if (value === undefined) {
        return [];
    }
    return Array.isArray(value) ? value : [value];
}

function maybeString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function toIsoTimestamp(value: number | undefined): string | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? new Date(value).toISOString()
        : undefined;
}

function compact<T extends Record<string, unknown>>(value: T): T {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
        if (item === undefined) {
            continue;
        }
        if (Array.isArray(item) && item.length === 0) {
            continue;
        }
        if (item && typeof item === 'object' && !Array.isArray(item) && Object.keys(item).length === 0) {
            continue;
        }
        result[key] = item;
    }
    return result as T;
}

export interface MavenServiceConfig {
    apiBaseUrl?: string;
    repoUrl?: string;
    timeout?: number;
    userAgent?: string;
    cacheDir?: string;
}

export class MavenService {
    private readonly httpClient: AxiosInstance;
    private readonly cacheDir: string;
    private readonly apiBaseUrl: string;
    private readonly repoUrl: string;
    private readonly metadataCache: Map<string, CachedPackageMetadata>;
    private readonly groupArtifactsCache: Map<string, CachedPackageMetadata>;
    private namespaceCache: { ids: string[]; timestamp: number } | null = null;

    constructor(config: MavenServiceConfig = {}) {
        this.apiBaseUrl = config.apiBaseUrl || MAVEN_REGISTRY.API_BASE_URL;
        this.repoUrl = config.repoUrl || MAVEN_REGISTRY.REPO_URL;
        this.cacheDir = config.cacheDir || CACHE_CONFIG.CACHE_DIR;
        this.metadataCache = new Map();
        this.groupArtifactsCache = new Map();

        const httpAgent = new http.Agent({ keepAlive: false, timeout: config.timeout || MAVEN_REGISTRY.TIMEOUT_MS });
        const httpsAgent = new https.Agent({ keepAlive: false, timeout: config.timeout || MAVEN_REGISTRY.TIMEOUT_MS });

        this.httpClient = axios.create({
            timeout: config.timeout || MAVEN_REGISTRY.TIMEOUT_MS,
            httpAgent,
            httpsAgent,
            headers: {
                'User-Agent': config.userAgent || MAVEN_REGISTRY.USER_AGENT,
                'Accept': 'application/json, application/xml, text/xml, text/plain'
            },
            validateStatus: (status) => status >= 200 && status < 500
        });

        if (!fs.existsSync(this.cacheDir)) {
            fs.mkdirSync(this.cacheDir, { recursive: true });
        }
    }

    async searchArtifacts(query: string, start: number = 0, rows: number = 50, core?: string): Promise<MavenSearchResponse> {
        const params: Record<string, string | number> = { q: query, start, rows, wt: 'json' };
        if (core) {
            params['core'] = core;
        }
        return this.solrQuery(params);
    }

    async solrQuery<T = MavenSearchResponse>(params: Record<string, string | number>): Promise<T> {
        const search = new URLSearchParams();
        for (const [key, value] of Object.entries(params)) {
            search.set(key, String(value));
        }
        if (!search.has('wt')) {
            search.set('wt', 'json');
        }
        return this.cachedGet<T>(`${this.apiBaseUrl}?${search.toString()}`);
    }

    async searchByCoordinates(groupId: string, artifactId: string): Promise<MavenSearchResponse> {
        return this.searchArtifacts(`g:"${groupId}" AND a:"${artifactId}"`, 0, 1);
    }

    async packageExists(groupId: string, artifactId: string): Promise<boolean> {
        try {
            const result = await this.searchByCoordinates(groupId, artifactId);
            return result.response.numFound > 0;
        } catch {
            return false;
        }
    }

    async fetchArtifactVersions(groupId: string, artifactId: string): Promise<string[]> {
        try {
            const xmlData = await this.cachedGet<string>(this.buildMetadataUrl(groupId, artifactId));
            const metadata = await parseXml(xmlData, { explicitArray: false }) as { metadata?: MavenArtifactMetadata };
            const versions = metadata.metadata?.versioning?.versions?.version;
            if (!versions) {
                return [];
            }
            return asArray(versions).filter((version): version is string => typeof version === 'string' && !version.endsWith('-SNAPSHOT'));
        } catch {
            return [];
        }
    }

    async fetchVersionSummary(groupId: string, artifactId: string, version: string): Promise<MavenArtifactDoc | null> {
        const response = await this.searchArtifacts(`g:"${groupId}" AND a:"${artifactId}" AND v:"${version}"`, 0, 1, 'gav');
        return response.response.docs[0] ?? null;
    }

    async fetchAllNamespaceIds(): Promise<string[]> {
        const now = Date.now();
        if (this.namespaceCache && now - this.namespaceCache.timestamp < CACHE_CONFIG.CACHE_TTL_MS) {
            return this.namespaceCache.ids;
        }

        const ids: string[] = [];
        let offset = 0;

        while (true) {
            const response = await this.solrQuery<any>({
                q: '*:*',
                rows: 0,
                facet: 'true',
                'facet.field': 'g',
                'facet.limit': FACET_BATCH_SIZE,
                'facet.offset': offset,
                'facet.sort': 'index',
                'facet.mincount': 1,
                wt: 'json'
            });

            const facetField = response?.facet_counts?.facet_fields?.g;
            if (!Array.isArray(facetField) || facetField.length === 0) {
                break;
            }

            for (let index = 0; index < facetField.length; index += 2) {
                const groupId = facetField[index];
                if (typeof groupId === 'string') {
                    ids.push(groupId);
                }
            }

            if (facetField.length < FACET_BATCH_SIZE * 2) {
                break;
            }

            offset += FACET_BATCH_SIZE;
        }

        const uniqueIds = Array.from(new Set(ids)).sort((left, right) => left.localeCompare(right));
        this.namespaceCache = { ids: uniqueIds, timestamp: now };
        return uniqueIds;
    }

    async resolveNamespaceId(groupId: string): Promise<string | null> {
        const map = buildNamespaceIdMap(await this.fetchAllNamespaceIds());
        return map.get(groupId) ?? null;
    }

    async resolveGroupId(namespaceId: string): Promise<string | null> {
        const map = buildNamespaceIdMap(await this.fetchAllNamespaceIds());
        for (const [groupId, resolvedNamespaceId] of map.entries()) {
            if (resolvedNamespaceId === namespaceId) {
                return groupId;
            }
        }
        return null;
    }

    async fetchGroupArtifacts(groupId: string): Promise<MavenArtifactDoc[]> {
        const cached = this.groupArtifactsCache.get(groupId);
        if (cached && Date.now() - cached.timestamp < CACHE_CONFIG.CACHE_TTL_MS) {
            return cached.data as MavenArtifactDoc[];
        }

        const docs: MavenArtifactDoc[] = [];
        let start = 0;
        while (true) {
            const response = await this.searchArtifacts(`g:"${groupId}"`, start, MAX_SOLR_ROWS);
            docs.push(...response.response.docs.filter((doc) => doc.g === groupId));
            if (docs.length >= response.response.numFound || response.response.docs.length < MAX_SOLR_ROWS) {
                break;
            }
            start += MAX_SOLR_ROWS;
        }

        this.groupArtifactsCache.set(groupId, { data: docs, timestamp: Date.now() });
        return docs;
    }

    async resolvePackageId(groupId: string, artifactId: string): Promise<string> {
        const docs = await this.fetchGroupArtifacts(groupId);
        const idMap = buildPackageIdMap(docs.map((doc) => doc.a));
        return idMap.get(artifactId) ?? buildHashedEntityId(artifactId);
    }

    async resolveArtifactId(groupId: string, packageId: string): Promise<string | null> {
        const docs = await this.fetchGroupArtifacts(groupId);
        const idMap = buildPackageIdMap(docs.map((doc) => doc.a));
        for (const [artifactId, resolvedPackageId] of idMap.entries()) {
            if (resolvedPackageId === packageId) {
                return artifactId;
            }
        }
        if (!isHashedIdentity(packageId) && docs.some((doc) => doc.a === packageId)) {
            return packageId;
        }
        return null;
    }

    async resolveVersion(versionId: string, versions: string[]): Promise<string | null> {
        for (const version of versions) {
            if (toVersionId(version) === versionId) {
                return version;
            }
        }
        return null;
    }

    async fetchResolvedVersion(groupId: string, artifactId: string, version: string): Promise<MavenResolvedVersion | null> {
        const versionSummary = await this.fetchVersionSummary(groupId, artifactId, version);
        if (!versionSummary) {
            return null;
        }

        const pomProject = await this.fetchPomProject(groupId, artifactId, version);
        const packaging = maybeString(pomProject?.packaging) || maybeString(versionSummary.p);
        const publishedFiles = this.buildPublishedFiles(groupId, artifactId, version, versionSummary.ec, packaging);
        const primaryArtifact = this.resolvePrimaryArtifact(publishedFiles, packaging);
        const classifiers = Array.from(new Set(
            publishedFiles
                .filter((entry) => entry.classifier && entry.filename !== primaryArtifact?.filename)
                .map((entry) => entry.classifier as string)
        ));

        const checksums = await Promise.all(publishedFiles.map((entry) => this.buildChecksum(entry)));
        const signatures = await Promise.all(publishedFiles.map((entry) => this.buildSignature(entry)));

        const parent = pomProject ? await this.parseParent(pomProject.parent) : undefined;
        const organization = pomProject ? this.parseOrganization(pomProject.organization) : undefined;
        const developers = pomProject ? this.parseDevelopers(pomProject.developers) : undefined;
        const licenses = pomProject ? this.parseLicenses(pomProject.licenses) : undefined;
        const scm = pomProject ? this.parseScm(pomProject.scm) : undefined;
        const issueManagement = pomProject ? this.parseIssueManagement(pomProject.issueManagement) : undefined;
        const modules = pomProject ? this.parseModules(pomProject.modules) : undefined;
        const properties = pomProject ? this.parseProperties(pomProject.properties) : undefined;
        const profiles = pomProject ? this.parseProfiles(pomProject.profiles) : undefined;
        const dependencies = pomProject ? await this.parseDependencies(pomProject.dependencies) : undefined;
        const dependencyManagement = pomProject ? await this.parseDependencyManagement(pomProject.dependencyManagement) : undefined;

        return compact({
            groupId,
            artifactId,
            version,
            versionId: toVersionId(version),
            createdAt: toIsoTimestamp(versionSummary.timestamp),
            modifiedAt: toIsoTimestamp(versionSummary.timestamp),
            packaging,
            classifier: primaryArtifact?.classifier,
            classifiers: classifiers.length > 0 ? classifiers : undefined,
            snapshot: version.endsWith('-SNAPSHOT') ? true : undefined,
            pom_resolution: pomProject ? 'raw' : undefined,
            name: pomProject ? maybeString(pomProject.name) : undefined,
            description: pomProject ? maybeString(pomProject.description) : undefined,
            homepage: pomProject ? maybeString(pomProject.url) : undefined,
            parent,
            modules,
            properties,
            profiles,
            checksums: checksums.filter((entry): entry is MavenChecksum => entry !== undefined),
            signatures: signatures.filter((entry): entry is MavenSignature => entry !== undefined),
            organization,
            developers,
            licenses,
            scm,
            issue_management: issueManagement,
            dependencies,
            dependency_management: dependencyManagement
        }) as MavenResolvedVersion;
    }

    private async fetchPomProject(groupId: string, artifactId: string, version: string): Promise<any | null> {
        try {
            const pomXml = await this.cachedGet<string>(this.buildPomUrl(groupId, artifactId, version));
            const pom = await parseXml(pomXml, { explicitArray: false }) as { project?: any };
            return pom.project ?? null;
        } catch {
            return null;
        }
    }

    private buildMetadataUrl(groupId: string, artifactId: string): string {
        return `${this.repoUrl}/${groupId.replace(/\./g, '/')}/${artifactId}/maven-metadata.xml`;
    }

    private buildPomUrl(groupId: string, artifactId: string, version: string): string {
        return `${this.repoUrl}/${groupId.replace(/\./g, '/')}/${artifactId}/${version}/${artifactId}-${version}.pom`;
    }

    buildJarUrl(groupId: string, artifactId: string, version: string): string {
        return `${this.repoUrl}/${groupId.replace(/\./g, '/')}/${artifactId}/${version}/${artifactId}-${version}.jar`;
    }

    private buildArtifactBaseUrl(groupId: string, artifactId: string, version: string): string {
        return `${this.repoUrl}/${groupId.replace(/\./g, '/')}/${artifactId}/${version}`;
    }

    private buildPublishedFiles(groupId: string, artifactId: string, version: string, extensions: string[] | undefined, packaging: string | undefined): PublishedFile[] {
        const baseUrl = this.buildArtifactBaseUrl(groupId, artifactId, version);
        const suffixes = new Set<string>(extensions ?? []);
        suffixes.add('.pom');
        if (packaging) {
            suffixes.add(`.${packaging}`);
        }

        const publishedFiles: PublishedFile[] = [];
        for (const suffix of suffixes) {
            if (!suffix || suffix.endsWith('.asc') || suffix.includes('.sha')) {
                continue;
            }
            if (suffix.startsWith('.')) {
                const filename = `${artifactId}-${version}${suffix}`;
                publishedFiles.push({ filename, extension: suffix.slice(1), url: `${baseUrl}/${filename}` });
                continue;
            }
            if (!suffix.startsWith('-')) {
                continue;
            }
            const dotIndex = suffix.indexOf('.');
            if (dotIndex <= 1) {
                continue;
            }
            const filename = `${artifactId}-${version}${suffix}`;
            publishedFiles.push({
                filename,
                classifier: suffix.slice(1, dotIndex),
                extension: suffix.slice(dotIndex + 1),
                url: `${baseUrl}/${filename}`
            });
        }

        return publishedFiles.sort((left, right) => left.filename.localeCompare(right.filename));
    }

    private resolvePrimaryArtifact(entries: PublishedFile[], packaging: string | undefined): PublishedFile | undefined {
        if (!packaging) {
            return entries.find((entry) => entry.extension !== 'pom' && !entry.classifier);
        }
        const samePackaging = entries.filter((entry) => entry.extension === packaging);
        const unclassified = samePackaging.find((entry) => !entry.classifier);
        return unclassified || (samePackaging.length === 1 ? samePackaging[0] : undefined);
    }

    private async buildChecksum(entry: PublishedFile): Promise<MavenChecksum | undefined> {
        const [size, md5, sha1, sha256, sha512] = await Promise.all([
            this.headContentLength(entry.url),
            this.fetchDigest(`${entry.url}.md5`),
            this.fetchDigest(`${entry.url}.sha1`),
            this.fetchDigest(`${entry.url}.sha256`),
            this.fetchDigest(`${entry.url}.sha512`)
        ]);
        if (!md5 && !sha1 && !sha256 && !sha512) {
            return undefined;
        }
        return compact({
            filename: entry.filename,
            classifier: entry.classifier,
            extension: entry.extension,
            url: entry.url,
            size,
            md5,
            sha1,
            sha256,
            sha512
        }) as MavenChecksum;
    }

    private async buildSignature(entry: PublishedFile): Promise<MavenSignature | undefined> {
        const signatureUrl = `${entry.url}.asc`;
        if (!(await this.headExists(signatureUrl))) {
            return undefined;
        }
        return { filename: entry.filename, url: signatureUrl, format: 'pgp' };
    }

    private async parseParent(parentNode: any): Promise<MavenParentReference | undefined> {
        if (!parentNode) {
            return undefined;
        }
        const groupId = maybeString(parentNode.groupId);
        const artifactId = maybeString(parentNode.artifactId);
        return compact({
            group_id: groupId,
            artifact_id: artifactId,
            version: maybeString(parentNode.version),
            relative_path: maybeString(parentNode.relativePath),
            package: groupId && artifactId ? await this.buildPackageXid(groupId, artifactId) : undefined
        }) as MavenParentReference;
    }

    private parseOrganization(node: any): { name?: string; url?: string } | undefined {
        if (!node) {
            return undefined;
        }
        return compact({ name: maybeString(node.name), url: maybeString(node.url) }) as { name?: string; url?: string };
    }

    private parseDevelopers(node: any): MavenDeveloper[] | undefined {
        const developers = asArray(node?.developer)
            .map((developer) => compact({
                id: maybeString(developer?.id),
                name: maybeString(developer?.name),
                email: maybeString(developer?.email),
                url: maybeString(developer?.url)
            }) as MavenDeveloper)
            .filter((developer) => Object.keys(developer).length > 0);
        return developers.length > 0 ? developers : undefined;
    }

    private parseLicenses(node: any): MavenLicense[] | undefined {
        const licenses = asArray(node?.license)
            .map((license) => compact({
                name: maybeString(license?.name),
                url: maybeString(license?.url),
                distribution: maybeString(license?.distribution),
                comments: maybeString(license?.comments)
            }) as MavenLicense)
            .filter((license) => Object.keys(license).length > 0);
        return licenses.length > 0 ? licenses : undefined;
    }

    private parseScm(node: any): MavenScm | undefined {
        if (!node) {
            return undefined;
        }
        return compact({
            url: maybeString(node.url),
            connection: maybeString(node.connection),
            developer_connection: maybeString(node.developerConnection)
        }) as MavenScm;
    }

    private parseIssueManagement(node: any): MavenIssueManagement | undefined {
        if (!node) {
            return undefined;
        }
        return compact({ system: maybeString(node.system), url: maybeString(node.url) }) as MavenIssueManagement;
    }

    private parseModules(node: any): string[] | undefined {
        const modules = asArray(node?.module)
            .map((moduleName) => maybeString(moduleName))
            .filter((moduleName): moduleName is string => moduleName !== undefined);
        return modules.length > 0 ? modules : undefined;
    }

    private parseProperties(node: any): Record<string, string> | undefined {
        if (!node || typeof node !== 'object') {
            return undefined;
        }
        const properties: Record<string, string> = {};
        for (const [key, value] of Object.entries(node)) {
            if (key === '$') {
                continue;
            }
            const text = maybeString(value);
            if (text) {
                properties[key] = text;
            }
        }
        return Object.keys(properties).length > 0 ? properties : undefined;
    }

    private parseProfiles(node: any): MavenProfile[] | undefined {
        const profiles = asArray(node?.profile)
            .map((profile) => {
                const activation = profile?.activation;
                const activationPropertyName = maybeString(activation?.property?.name);
                const activationPropertyValue = maybeString(activation?.property?.value);
                const activationOs = activation?.os && typeof activation.os === 'object'
                    ? Object.entries(activation.os)
                        .map(([key, value]) => {
                            const text = maybeString(value);
                            return text ? `${key}=${text}` : undefined;
                        })
                        .filter((value): value is string => value !== undefined)
                        .join(', ')
                    : undefined;
                const activationFile = activation?.file && typeof activation.file === 'object'
                    ? Object.entries(activation.file)
                        .map(([key, value]) => {
                            const text = maybeString(value);
                            return text ? `${key}=${text}` : undefined;
                        })
                        .filter((value): value is string => value !== undefined)
                        .join(', ')
                    : undefined;
                return compact({
                    id: maybeString(profile?.id),
                    active_by_default: maybeString(activation?.activeByDefault) === 'true' ? true : undefined,
                    activation_jdk: maybeString(activation?.jdk),
                    activation_os: activationOs || undefined,
                    activation_property: activationPropertyName
                        ? `${activationPropertyName}${activationPropertyValue ? `=${activationPropertyValue}` : ''}`
                        : undefined,
                    activation_file: activationFile || undefined
                }) as MavenProfile;
            })
            .filter((profile) => Object.keys(profile).length > 0);
        return profiles.length > 0 ? profiles : undefined;
    }

    private async parseDependencies(node: any): Promise<MavenDependency[] | undefined> {
        const dependencies = await Promise.all(asArray(node?.dependency).map((dependency) => this.parseDependency(dependency)));
        const projected = dependencies.filter((dependency): dependency is MavenDependency => dependency !== undefined);
        return projected.length > 0 ? projected : undefined;
    }

    private async parseDependencyManagement(node: any): Promise<MavenDependency[] | undefined> {
        const dependencies = await Promise.all(asArray(node?.dependencies?.dependency).map((dependency) => this.parseDependency(dependency)));
        const projected = dependencies.filter((dependency): dependency is MavenDependency => dependency !== undefined);
        return projected.length > 0 ? projected : undefined;
    }

    private async parseDependency(node: any): Promise<MavenDependency | undefined> {
        const groupId = maybeString(node?.groupId);
        const artifactId = maybeString(node?.artifactId);
        if (!groupId || !artifactId) {
            return undefined;
        }
        const exclusions = asArray(node?.exclusions?.exclusion)
            .map((exclusion) => compact({
                group_id: maybeString(exclusion?.groupId),
                artifact_id: maybeString(exclusion?.artifactId)
            }))
            .filter((exclusion) => Object.keys(exclusion).length > 0);

        return compact({
            group_id: groupId,
            artifact_id: artifactId,
            version: maybeString(node?.version),
            classifier: maybeString(node?.classifier),
            type: maybeString(node?.type),
            scope: maybeString(node?.scope),
            optional: maybeString(node?.optional) === 'true' ? true : undefined,
            system_path: maybeString(node?.systemPath),
            exclusions: exclusions.length > 0 ? exclusions : undefined,
            package: await this.buildPackageXid(groupId, artifactId)
        }) as MavenDependency;
    }

    private async buildPackageXid(groupId: string, artifactId: string): Promise<string | undefined> {
        if (!(await this.packageExists(groupId, artifactId))) {
            return undefined;
        }
        const namespaceId = await this.resolveNamespaceId(groupId);
        if (!namespaceId) {
            return undefined;
        }
        const packageId = await this.resolvePackageId(groupId, artifactId);
        return `/javanamespaces/${namespaceId}/packages/${packageId}`;
    }

    private async fetchDigest(url: string): Promise<string | undefined> {
        try {
            const response = await this.httpClient.get<string>(url, { responseType: 'text', transformResponse: [(value) => value] });
            if (response.status >= 400) {
                return undefined;
            }
            const body = typeof response.data === 'string' ? response.data : String(response.data);
            return body.toLowerCase().match(/[a-f0-9]{32,128}/)?.[0];
        } catch {
            return undefined;
        }
    }

    private async headExists(url: string): Promise<boolean> {
        try {
            const response = await this.httpClient.head(url);
            return response.status >= 200 && response.status < 300;
        } catch {
            return false;
        }
    }

    private async headContentLength(url: string): Promise<number | undefined> {
        try {
            const response = await this.httpClient.head(url);
            if (response.status >= 400) {
                return undefined;
            }
            const value = response.headers['content-length'];
            const length = value ? parseInt(String(value), 10) : NaN;
            return Number.isFinite(length) && length >= 0 ? length : undefined;
        } catch {
            return undefined;
        }
    }

    private async cachedGet<T>(url: string): Promise<T> {
        const cacheKey = Buffer.from(url).toString('base64').substring(0, 200);
        const cacheFile = path.join(this.cacheDir, cacheKey);
        if (fs.existsSync(cacheFile)) {
            try {
                const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as CachedPackageMetadata;
                if (Date.now() - cached.timestamp < CACHE_CONFIG.CACHE_TTL_MS) {
                    return cached.data as T;
                }
            } catch {
                // ignore invalid cache entries
            }
        }

        try {
            const response = await this.httpClient.get<T>(url);
            if (response.status >= 400) {
                throw new Error(`HTTP ${response.status} for ${url}`);
            }
            const cacheData: CachedPackageMetadata = {
                data: response.data,
                timestamp: Date.now(),
                etag: response.headers['etag']
            };
            fs.writeFileSync(cacheFile, JSON.stringify(cacheData));
            return response.data;
        } catch (error) {
            if (fs.existsSync(cacheFile)) {
                try {
                    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as CachedPackageMetadata;
                    return cached.data as T;
                } catch {
                    // fall through
                }
            }
            throw error;
        }
    }

    clearCache(): void {
        this.metadataCache.clear();
        this.groupArtifactsCache.clear();
        this.namespaceCache = null;
        if (fs.existsSync(this.cacheDir)) {
            for (const file of fs.readdirSync(this.cacheDir)) {
                fs.unlinkSync(path.join(this.cacheDir, file));
            }
        }
    }
}
