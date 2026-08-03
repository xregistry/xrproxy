/**
 * Package Service - Handles package and version metadata operations.
 */

import { EntityStateManager } from '../../../shared/entity-state-manager';
import {
    PyPIPackageFile,
    PyPIPackageInfo,
    PyPIPackageResponse,
    PyPISimpleFile,
    PyPISimpleProjectResponse,
    PyPIVulnerability,
} from '../types/pypi';
import { entityNotFound } from '../utils/xregistry-errors';
import {
    buildPackagePath,
    buildPackageXid,
    buildVersionPath,
    extractDependencyPackageId,
    normalizePackageId,
    toVersionId,
} from '../utils/identity';
import { PyPIService } from './pypi-service';

export class PackageService {
    private pypiService: PyPIService;
    private readonly entityState: EntityStateManager;

    constructor(pypiService: PyPIService, entityState: EntityStateManager) {
        this.pypiService = pypiService;
        this.entityState = entityState;
    }

    async getPackageMetadata(packageName: string, baseUrl: string): Promise<any> {
        const packageId = normalizePackageId(packageName);
        const [packageData, simpleProject] = await Promise.all([
            this.pypiService.fetchPackageMetadata(packageId),
            this.pypiService.fetchSimpleProject(packageId),
        ]);
        const versions = this.getVersionSequence(packageData, simpleProject);
        const releaseVersion = packageData.info.version;
        const versionId = toVersionId(releaseVersion);
        const resourcePath = buildPackagePath(packageId);
        const resourceBasePath = `${baseUrl}${resourcePath}`;

        return {
            packageid: packageId,
            versionid: versionId,
            xid: resourcePath,
            self: resourceBasePath,
            ...this.buildCoreVersionFields(
                resourcePath,
                packageData.info.name,
                packageData.info.description,
                releaseVersion,
                packageData.urls,
                versions,
                packageData.info.version
            ),
            ...this.mapInfoToAttributes(packageData.info),
            urls: this.mapDistributionFiles(packageData.urls, simpleProject),
            vulnerabilities: this.mapVulnerabilities(packageData.vulnerabilities),
            ...(this.mapReplacedBy(simpleProject) ?? {}),
            metaurl: `${resourceBasePath}/meta`,
            versionsurl: `${resourceBasePath}/versions`,
            versionscount: versions.length,
        };
    }

    async getPackageVersions(packageName: string, baseUrl: string): Promise<Record<string, any>> {
        const packageId = normalizePackageId(packageName);
        const [packageData, simpleProject] = await Promise.all([
            this.pypiService.fetchPackageMetadata(packageId),
            this.pypiService.fetchSimpleProject(packageId),
        ]);
        const versions = this.getVersionSequence(packageData, simpleProject);
        const versionBasePath = `${baseUrl}${buildPackagePath(packageId)}/versions`;
        const versionEntries: Record<string, any> = {};

        for (const releaseVersion of versions) {
            const versionId = toVersionId(releaseVersion);
            const versionPath = buildVersionPath(packageId, versionId);
            const files = packageData.releases[releaseVersion] || [];

            versionEntries[versionId] = {
                packageid: packageId,
                versionid: versionId,
                xid: versionPath,
                self: `${versionBasePath}/${versionId}`,
                ...this.buildCoreVersionFields(
                    versionPath,
                    releaseVersion,
                    undefined,
                    releaseVersion,
                    files,
                    versions,
                    packageData.info.version
                ),
            };
        }

        return versionEntries;
    }

    async getVersionDetails(
        packageName: string,
        requestedVersionId: string,
        baseUrl: string
    ): Promise<any> {
        const packageId = normalizePackageId(packageName);
        const [packageData, simpleProject] = await Promise.all([
            this.pypiService.fetchPackageMetadata(packageId),
            this.pypiService.fetchSimpleProject(packageId),
        ]);
        const versions = this.getVersionSequence(packageData, simpleProject);
        const releaseVersion = this.findReleaseVersion(versions, requestedVersionId);

        if (!releaseVersion) {
            throw entityNotFound(
                `${buildPackagePath(packageId)}/versions/${requestedVersionId}`,
                'version',
                requestedVersionId
            );
        }

        const versionData = releaseVersion === packageData.info.version
            ? packageData
            : await this.pypiService.fetchVersionMetadata(packageId, releaseVersion);
        const versionId = toVersionId(releaseVersion);
        const versionPath = buildVersionPath(packageId, versionId);
        const versionBasePath = `${baseUrl}${versionPath}`;

        return {
            packageid: packageId,
            versionid: versionId,
            xid: versionPath,
            self: versionBasePath,
            ...this.buildCoreVersionFields(
                versionPath,
                releaseVersion,
                versionData.info.description,
                releaseVersion,
                versionData.urls,
                versions,
                packageData.info.version
            ),
            ...this.mapInfoToAttributes(versionData.info),
            urls: this.mapDistributionFiles(versionData.urls, simpleProject),
            vulnerabilities: this.mapVulnerabilities(versionData.vulnerabilities),
            ...(this.mapReplacedBy(simpleProject) ?? {}),
        };
    }

    async getPackageMeta(packageName: string, baseUrl: string): Promise<any> {
        const packageId = normalizePackageId(packageName);
        const [packageData, simpleProject] = await Promise.all([
            this.pypiService.fetchPackageMetadata(packageId),
            this.pypiService.fetchSimpleProject(packageId),
        ]);
        const resourceBasePath = `${baseUrl}${buildPackagePath(packageId)}`;
        const metaPath = `${buildPackagePath(packageId)}/meta`;

        return {
            packageid: packageId,
            xid: metaPath,
            self: `${resourceBasePath}/meta`,
            epoch: this.entityState.getEpoch(metaPath),
            createdat: this.entityState.getCreatedAt(metaPath),
            modifiedat: this.entityState.getModifiedAt(metaPath),
            readonly: true,
            compatibility: 'none',
            defaultversionid: toVersionId(packageData.info.version),
            defaultversionurl: `${resourceBasePath}/versions/${toVersionId(packageData.info.version)}`,
            defaultversionsticky: true,
            ...this.mapOrganization(simpleProject),
        };
    }

    async getPackageDoc(packageName: string): Promise<{ content: string; contentType: string }> {
        const packageData = await this.pypiService.fetchPackageMetadata(packageName);
        const { info } = packageData;

        return {
            content: info.description || '',
            contentType: info.description_content_type || 'text/plain',
        };
    }

    private buildCoreVersionFields(
        entityPath: string,
        entityName: string,
        entityDescription: string | null | undefined,
        releaseVersion: string,
        files: PyPIPackageFile[],
        orderedVersions: string[],
        defaultVersion: string
    ): Record<string, any> {
        const timestamps = this.getVersionTimestamps(entityPath, files);

        return {
            epoch: this.entityState.getEpoch(entityPath),
            createdat: timestamps.createdat,
            modifiedat: timestamps.modifiedat,
            name: entityName || releaseVersion,
            ...(entityDescription ? { description: entityDescription } : {}),
            version: releaseVersion,
            ancestor: this.getAncestorVersionId(orderedVersions, releaseVersion),
            isdefault: releaseVersion === defaultVersion,
        };
    }

    private mapInfoToAttributes(info: PyPIPackageInfo): Record<string, any> {
        const attributes: Record<string, any> = {};

        this.setIfPresent(attributes, 'documentation', this.extractDocumentationUrl(info));
        this.setIfPresent(attributes, 'summary', info.summary);
        if (info.license_expression) {
            this.setIfPresent(attributes, 'license_expression', info.license_expression);
        } else {
            this.setIfPresent(attributes, 'license', info.license);
        }
        if (info.license_files && info.license_files.length > 0) {
            attributes['license_files'] = info.license_files;
        }
        this.setIfPresent(attributes, 'author', info.author);
        this.setIfPresent(attributes, 'author_email', info.author_email);
        this.setIfPresent(attributes, 'maintainer', info.maintainer);
        this.setIfPresent(attributes, 'maintainer_email', info.maintainer_email);
        this.setIfPresent(attributes, 'home_page', info.home_page);
        this.setIfPresent(attributes, 'project_url', info.project_url);
        if (info.project_urls && Object.keys(info.project_urls).length > 0) {
            attributes['project_urls'] = info.project_urls;
        }
        this.setIfPresent(attributes, 'keywords', info.keywords);
        this.setIfPresent(attributes, 'description_content_type', info.description_content_type);
        if (info.requires_dist && info.requires_dist.length > 0) {
            attributes['requires_dist'] = info.requires_dist.map((specifier) => {
                const dependencyPackageId = extractDependencyPackageId(specifier);
                return {
                    specifier,
                    ...(dependencyPackageId
                        ? { package: buildPackageXid(dependencyPackageId) }
                        : {}),
                };
            });
        }
        this.setIfPresent(attributes, 'requires_python', info.requires_python);
        if (info.classifiers && info.classifiers.length > 0) {
            attributes['classifiers'] = info.classifiers;
        }
        if (info.provides_extra && info.provides_extra.length > 0) {
            attributes['provides_extra'] = info.provides_extra;
        }
        this.setIfPresent(attributes, 'platform', info.platform);
        if (info.dynamic && info.dynamic.length > 0) {
            attributes['dynamic'] = info.dynamic;
        }

        return attributes;
    }

    private mapDistributionFiles(
        files: PyPIPackageFile[],
        simpleProject: PyPISimpleProjectResponse
    ): any[] | undefined {
        if (!files || files.length === 0) {
            return undefined;
        }

        const simpleFilesByName = new Map<string, PyPISimpleFile>();
        for (const simpleFile of simpleProject.files || []) {
            simpleFilesByName.set(simpleFile.filename, simpleFile);
        }

        return files.map((file) => {
            const simpleFile = simpleFilesByName.get(file.filename);
            const digests = {
                sha256: file.digests?.sha256 || simpleFile?.hashes?.['sha256'],
                md5: file.digests?.md5 || simpleFile?.hashes?.['md5'] || file.md5_digest,
                blake2b_256: file.digests?.blake2b_256 || simpleFile?.hashes?.['blake2b_256'],
            };
            const coreMetadata = this.normalizeCoreMetadata(
                file['core-metadata'] ?? simpleFile?.['core-metadata'] ?? simpleFile?.['data-dist-info-metadata']
            );

            const mapped: Record<string, any> = {
                filename: file.filename,
                url: file.url,
            };

            this.setIfPresent(mapped, 'packagetype', file.packagetype);
            this.setIfPresent(mapped, 'python_version', file.python_version);
            this.setIfPresent(
                mapped,
                'requires_python',
                file.requires_python ?? simpleFile?.['requires-python']
            );
            if (typeof file.size === 'number') {
                mapped['size'] = file.size;
            } else if (typeof simpleFile?.size === 'number') {
                mapped['size'] = simpleFile.size;
            }
            this.setIfPresent(
                mapped,
                'upload_time',
                file.upload_time || file.upload_time_iso_8601 || simpleFile?.['upload-time']
            );
            this.setIfPresent(
                mapped,
                'upload_time_iso_8601',
                file.upload_time_iso_8601 || simpleFile?.['upload-time']
            );
            if (typeof file.yanked === 'boolean') {
                mapped['yanked'] = file.yanked;
            } else if (typeof simpleFile?.yanked === 'boolean') {
                mapped['yanked'] = simpleFile.yanked;
            }
            this.setIfPresent(mapped, 'yanked_reason', file.yanked_reason);
            if (coreMetadata !== undefined) {
                mapped['core_metadata'] = coreMetadata;
            }
            if (simpleFile?.provenance) {
                mapped['provenance'] = simpleFile.provenance;
            }

            const digestMap: Record<string, string> = {};
            this.setIfPresent(digestMap, 'sha256', digests.sha256);
            this.setIfPresent(digestMap, 'md5', digests.md5);
            this.setIfPresent(digestMap, 'blake2b_256', digests.blake2b_256);
            if (Object.keys(digestMap).length > 0) {
                mapped['digests'] = digestMap;
            }

            return mapped;
        });
    }

    private mapVulnerabilities(vulnerabilities?: PyPIVulnerability[]): any[] | undefined {
        if (!vulnerabilities || vulnerabilities.length === 0) {
            return undefined;
        }

        return vulnerabilities.map((vulnerability) => {
            const mapped: Record<string, any> = {
                id: vulnerability.id,
            };

            if (vulnerability.aliases && vulnerability.aliases.length > 0) {
                mapped['aliases'] = vulnerability.aliases;
            }
            this.setIfPresent(mapped, 'summary', vulnerability.summary);
            this.setIfPresent(mapped, 'details', vulnerability.details);
            if (vulnerability.fixed_in && vulnerability.fixed_in.length > 0) {
                mapped['fixed_in'] = vulnerability.fixed_in;
            }
            this.setIfPresent(mapped, 'link', vulnerability.link);
            this.setIfPresent(mapped, 'source', vulnerability.source);
            this.setIfPresent(mapped, 'withdrawn', vulnerability.withdrawn);

            return mapped;
        });
    }

    private mapOrganization(simpleProject: PyPISimpleProjectResponse): Record<string, any> {
        const organization = this.getStringProperty(simpleProject as unknown as Record<string, unknown>, 'organization');
        return organization ? { organization } : {};
    }

    private mapReplacedBy(simpleProject: PyPISimpleProjectResponse): Record<string, any> | undefined {
        const status = simpleProject['project-status'];
        const replacement = status?.['replaced-by'] || status?.replaced_by;
        if (!replacement) {
            return undefined;
        }

        return {
            replacedby: buildPackageXid(normalizePackageId(replacement)),
        };
    }

    private extractDocumentationUrl(info: PyPIPackageInfo): string | undefined {
        if (info.docs_url) {
            return info.docs_url;
        }

        const projectUrls = info.project_urls || {};
        const docKeys = ['Documentation', 'Docs', 'docs', 'documentation'];
        for (const key of docKeys) {
            const url = projectUrls[key];
            if (url) {
                return url;
            }
        }

        return undefined;
    }

    private getVersionSequence(
        packageData: PyPIPackageResponse,
        simpleProject: PyPISimpleProjectResponse
    ): string[] {
        const versions = simpleProject.versions && simpleProject.versions.length > 0
            ? simpleProject.versions
            : Object.keys(packageData.releases || {});
        const unique: string[] = [];

        for (const version of versions) {
            if (!unique.includes(version)) {
                unique.push(version);
            }
        }

        if (packageData.info.version && !unique.includes(packageData.info.version)) {
            unique.push(packageData.info.version);
        }

        return unique;
    }

    private getAncestorVersionId(orderedVersions: string[], releaseVersion: string): string {
        const index = orderedVersions.indexOf(releaseVersion);
        if (index <= 0) {
            return toVersionId(releaseVersion);
        }

        return toVersionId(orderedVersions[index - 1]);
    }

    private findReleaseVersion(orderedVersions: string[], requestedVersionId: string): string | undefined {
        return orderedVersions.find((version) =>
            toVersionId(version) === requestedVersionId || version === requestedVersionId
        );
    }

    private getVersionTimestamps(entityPath: string, files: PyPIPackageFile[]): {
        createdat: string;
        modifiedat: string;
    } {
        const timestamps = files
            .map((file) => file.upload_time_iso_8601 || file.upload_time)
            .filter((value): value is string => Boolean(value))
            .map((value) => ({ value, time: Date.parse(value) }))
            .filter((entry) => !Number.isNaN(entry.time))
            .sort((a, b) => a.time - b.time);

        if (timestamps.length === 0) {
            return {
                createdat: this.entityState.getCreatedAt(entityPath),
                modifiedat: this.entityState.getModifiedAt(entityPath),
            };
        }

        return {
            createdat: timestamps[0]?.value || this.entityState.getCreatedAt(entityPath),
            modifiedat: timestamps[timestamps.length - 1]?.value || this.entityState.getModifiedAt(entityPath),
        };
    }

    private normalizeCoreMetadata(
        value: boolean | Record<string, string> | null | undefined
    ): boolean | Record<string, string> | undefined {
        if (value === true) {
            return true;
        }

        if (value && typeof value === 'object') {
            return value;
        }

        return undefined;
    }

    private getStringProperty(record: Record<string, unknown>, key: string): string | undefined {
        const value = record[key];
        return typeof value === 'string' && value.length > 0 ? value : undefined;
    }

    private setIfPresent(target: Record<string, any>, key: string, value: unknown): void {
        if (typeof value === 'string') {
            if (value.length > 0) {
                target[key] = value;
            }
            return;
        }

        if (value !== undefined && value !== null) {
            target[key] = value;
        }
    }
}
