/**
 * Package Service
 * @fileoverview Package and version operations for Maven packages
 */

import { GROUP_CONFIG, RESOURCE_CONFIG } from '../config/constants';
import { throwEntityNotFound } from '../middleware/xregistry-error-handler';
import { Resource } from '../types/xregistry';
import { toVersionId } from '../utils/maven-identity';
import { MavenService } from './maven-service';
import { SearchResult, SearchService } from './search-service';
import { EntityStateManager } from '../../../shared/entity-state-manager';

export interface PackageServiceOptions {
    mavenService: MavenService;
    searchService: SearchService;
    entityState?: EntityStateManager;
}

export interface PackageQueryOptions {
    limit?: number | undefined;
    offset?: number | undefined;
    filter?: string | undefined;
    sort?: string | undefined;
    query?: string | undefined;
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

export class PackageService {
    private readonly mavenService: MavenService;
    private readonly searchService: SearchService;
    private readonly entityState: EntityStateManager;

    constructor(options: PackageServiceOptions) {
        this.mavenService = options.mavenService;
        this.searchService = options.searchService;
        this.entityState = options.entityState || new EntityStateManager();
    }

    async getAllPackages(namespaceId: string, baseUrl: string, options: PackageQueryOptions = {}): Promise<{ packages: Record<string, Resource>; totalCount: number }> {
        const namespace = await this.searchService.getNamespaceById(namespaceId);
        if (!namespace) {
            throwEntityNotFound(`/${GROUP_CONFIG.TYPE}/${namespaceId}`, GROUP_CONFIG.TYPE_SINGULAR, namespaceId);
        }

        const searchOptions: { limit?: number; offset?: number; query?: string } = {};
        if (options.limit !== undefined) searchOptions.limit = options.limit;
        if (options.offset !== undefined) searchOptions.offset = options.offset;
        if (options.query) searchOptions.query = options.query;

        const result = await this.searchService.searchPackagesInNamespace(namespace.groupId, searchOptions);
        let resources = await Promise.all(result.results.map((doc) => this.buildPackageSummary(doc, namespace.namespaceId, baseUrl)));
        resources = this.sortResources(resources, options.sort);

        const packages: Record<string, Resource> = {};
        for (const resource of resources) {
            packages[resource.packageid] = resource;
        }

        return { packages, totalCount: result.totalCount };
    }

    async getPackage(namespaceId: string, packageId: string, baseUrl: string): Promise<Resource> {
        const resolved = await this.resolvePackageCoordinates(namespaceId, packageId);
        const versions = await this.mavenService.fetchArtifactVersions(resolved.groupId, resolved.artifactId);
        const latestVersion = versions[versions.length - 1];
        if (!latestVersion) {
            throwEntityNotFound(`/${GROUP_CONFIG.TYPE}/${namespaceId}/${RESOURCE_CONFIG.TYPE}/${packageId}`, RESOURCE_CONFIG.TYPE_SINGULAR, packageId);
        }

        const projectedVersion = await this.getProjectedVersion(resolved.namespaceId, resolved.groupId, resolved.artifactId, latestVersion, packageId, baseUrl, versions);
        const packagePath = `/${GROUP_CONFIG.TYPE}/${resolved.namespaceId}/${RESOURCE_CONFIG.TYPE}/${packageId}`;
        const packageUrl = `${baseUrl}${packagePath}`;

        return compact({
            ...projectedVersion,
            xid: packagePath,
            self: packageUrl,
            packageid: packageId,
            versionid: toVersionId(latestVersion),
            metaurl: `${packageUrl}/meta`,
            versionsurl: `${packageUrl}/versions`,
            versionscount: versions.length
        }) as unknown as Resource;
    }

    async getPackageVersions(namespaceId: string, packageId: string, baseUrl: string, options: PackageQueryOptions = {}): Promise<{ versions: Record<string, Resource>; totalCount: number }> {
        const resolved = await this.resolvePackageCoordinates(namespaceId, packageId);
        const allVersions = await this.mavenService.fetchArtifactVersions(resolved.groupId, resolved.artifactId);
        const limit = options.limit || 50;
        const offset = options.offset || 0;
        const paginatedVersions = allVersions.slice(offset, offset + limit);

        const projected = await Promise.all(
            paginatedVersions.map((version) => this.getProjectedVersion(
                resolved.namespaceId,
                resolved.groupId,
                resolved.artifactId,
                version,
                packageId,
                baseUrl,
                allVersions
            ))
        );

        const versions: Record<string, Resource> = {};
        for (const version of this.sortResources(projected, options.sort)) {
            versions[version.versionid as string] = version;
        }

        return { versions, totalCount: allVersions.length };
    }

    async getVersion(namespaceId: string, packageId: string, versionId: string, baseUrl: string): Promise<Resource> {
        const resolved = await this.resolvePackageCoordinates(namespaceId, packageId);
        const versions = await this.mavenService.fetchArtifactVersions(resolved.groupId, resolved.artifactId);
        const version = versions.includes(versionId)
            ? versionId
            : await this.mavenService.resolveVersion(versionId, versions);

        if (!version) {
            throwEntityNotFound(`/${GROUP_CONFIG.TYPE}/${namespaceId}/${RESOURCE_CONFIG.TYPE}/${packageId}/versions/${versionId}`, 'version', versionId);
        }

        return this.getProjectedVersion(resolved.namespaceId, resolved.groupId, resolved.artifactId, version, packageId, baseUrl, versions);
    }

    private async resolvePackageCoordinates(namespaceId: string, packageId: string): Promise<{ namespaceId: string; groupId: string; artifactId: string }> {
        const namespace = await this.searchService.getNamespaceById(namespaceId);
        if (!namespace) {
            throwEntityNotFound(`/${GROUP_CONFIG.TYPE}/${namespaceId}`, GROUP_CONFIG.TYPE_SINGULAR, namespaceId);
        }

        const artifactId = await this.mavenService.resolveArtifactId(namespace.groupId, packageId);
        if (!artifactId) {
            throwEntityNotFound(`/${GROUP_CONFIG.TYPE}/${namespaceId}/${RESOURCE_CONFIG.TYPE}/${packageId}`, RESOURCE_CONFIG.TYPE_SINGULAR, packageId);
        }

        return { namespaceId: namespace.namespaceId, groupId: namespace.groupId, artifactId };
    }

    private async buildPackageSummary(doc: SearchResult, namespaceId: string, baseUrl: string): Promise<Resource> {
        const packageId = await this.mavenService.resolvePackageId(doc.groupId, doc.artifactId);
        const packagePath = `/${GROUP_CONFIG.TYPE}/${namespaceId}/${RESOURCE_CONFIG.TYPE}/${packageId}`;
        const packageUrl = `${baseUrl}${packagePath}`;

        return compact({
            xid: packagePath,
            self: packageUrl,
            packageid: packageId,
            versionid: toVersionId(doc.latestVersion),
            version: doc.latestVersion,
            name: doc.artifactId,
            epoch: this.entityState.getEpoch(packagePath),
            createdat: new Date(doc.timestamp).toISOString(),
            modifiedat: new Date(doc.timestamp).toISOString(),
            metaurl: `${packageUrl}/meta`,
            versionsurl: `${packageUrl}/versions`,
            versionscount: doc.versionCount,
            group_id: doc.groupId,
            artifact_id: doc.artifactId,
            snapshot: doc.latestVersion.endsWith('-SNAPSHOT') ? true : undefined
        }) as unknown as Resource;
    }

    private async getProjectedVersion(namespaceId: string, groupId: string, artifactId: string, version: string, packageId: string, baseUrl: string, allVersions: string[]): Promise<Resource> {
        const projected = await this.mavenService.fetchResolvedVersion(groupId, artifactId, version);
        if (!projected) {
            throwEntityNotFound(`/${GROUP_CONFIG.TYPE}/${namespaceId}/${RESOURCE_CONFIG.TYPE}/${packageId}/versions/${version}`, 'version', version);
        }

        const versionId = projected.versionId;
        const versionPath = `/${GROUP_CONFIG.TYPE}/${namespaceId}/${RESOURCE_CONFIG.TYPE}/${packageId}/versions/${versionId}`;
        const versionUrl = `${baseUrl}${versionPath}`;
        const versionIndex = allVersions.indexOf(version);
        const ancestor = versionIndex > 0 ? toVersionId(allVersions[versionIndex - 1] as string) : versionId;

        return compact({
            xid: versionPath,
            self: versionUrl,
            packageid: packageId,
            versionid: versionId,
            version: projected.version,
            name: projected.name || `${artifactId} ${version}`,
            description: projected.description,
            epoch: this.entityState.getEpoch(versionPath),
            createdat: projected.createdAt,
            modifiedat: projected.modifiedAt,
            ancestor,
            group_id: groupId,
            artifact_id: artifactId,
            packaging: projected.packaging,
            classifier: projected.classifier,
            classifiers: projected.classifiers,
            snapshot: projected.snapshot,
            pom_resolution: projected.pom_resolution,
            homepage: projected.homepage,
            parent: projected.parent,
            modules: projected.modules,
            properties: projected.properties,
            profiles: projected.profiles,
            checksums: projected.checksums,
            signatures: projected.signatures,
            organization: projected.organization,
            developers: projected.developers,
            licenses: projected.licenses,
            scm: projected.scm,
            issue_management: projected.issue_management,
            dependencies: projected.dependencies,
            dependency_management: projected.dependency_management
        }) as unknown as Resource;
    }

    private sortResources(resources: Resource[], sort: string | undefined): Resource[] {
        if (!sort) {
            return resources;
        }

        const parts = sort.split('=');
        const attribute = parts[0];
        const direction = parts[1]?.toLowerCase() == 'desc' ? 'desc' : 'asc';
        if (!attribute) {
            return resources;
        }

        return [...resources].sort((left, right) => {
            const leftValue = (left as Record<string, unknown>)[attribute];
            const rightValue = (right as Record<string, unknown>)[attribute];
            const comparison = String(leftValue ?? '').localeCompare(String(rightValue ?? ''), undefined, { sensitivity: 'base' });
            return direction == 'desc' ? -comparison : comparison;
        });
    }
}
