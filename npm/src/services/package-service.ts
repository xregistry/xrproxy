/**
 * Package Service
 * @fileoverview Service for package operations wrapping the npm service.
 */

import { throwEntityNotFound } from '../middleware/xregistry-error-handler';
import { PackageMetadata } from '../types/xregistry';
import { findVersionById } from '../utils/package-utils';
import { NpmService } from './npm-service';

export interface PackageServiceOptions {
    npmService: NpmService;
    baseUrl?: string;
}

export class PackageService {
    private readonly npmService: NpmService;
    private readonly baseUrl: string;

    constructor(options: PackageServiceOptions) {
        this.npmService = options.npmService;
        this.baseUrl = options.baseUrl || 'http://localhost:3100';
    }

    private buildInstanceUrl(nodescopeId: string, packageId: string, versionId?: string): string {
        const base = `/nodescopes/${nodescopeId}/packages/${packageId}`;
        return versionId ? `${base}/versions/${versionId}` : base;
    }

    async getAllPackages(
        filters: Record<string, string> = {},
        offset: number = 0,
        limit: number = 50
    ): Promise<{ packages: PackageMetadata[]; totalCount: number }> {
        const query = Object.keys(filters).length > 0 ? Object.values(filters).join(' ') : undefined;
        const options: { offset: number; limit: number; query?: string } = { offset, limit };
        if (query !== undefined) {
            options.query = query;
        }

        const result = await this.npmService.getPackages(options);
        return { packages: result.packages, totalCount: result.total };
    }

    async getPackage(nodescopeId: string, packageId: string): Promise<PackageMetadata> {
        const canonicalName = await this.npmService.resolveCanonicalPackageName(nodescopeId, packageId);
        if (!canonicalName) {
            throwEntityNotFound(this.buildInstanceUrl(nodescopeId, packageId), 'package', packageId);
        }

        const packageData = await this.npmService.getPackageMetadata(canonicalName);
        if (!packageData) {
            throwEntityNotFound(this.buildInstanceUrl(nodescopeId, packageId), 'package', packageId);
        }
        return packageData;
    }

    async getPackageVersions(nodescopeId: string, packageId: string): Promise<{ versions: any[]; totalCount: number }> {
        const packageData = await this.getPackage(nodescopeId, packageId);
        const versionKeys = Object.keys(packageData.versions || {});

        return {
            versions: versionKeys.map((version) => ({
                versionid: version.replace(/\+/g, '~'),
                version,
                self: `${this.baseUrl}/nodescopes/${nodescopeId}/packages/${packageId}/versions/${version.replace(/\+/g, '~')}`,
                epoch: 1,
                createdat: packageData.time?.[version] || new Date().toISOString(),
                modifiedat: packageData.time?.[version] || new Date().toISOString(),
            })),
            totalCount: versionKeys.length,
        };
    }

    async getPackageVersion(nodescopeId: string, packageId: string, versionId: string): Promise<any> {
        const packageData = await this.getPackage(nodescopeId, packageId);
        const upstreamVersion = findVersionById(versionId, Object.keys(packageData.versions || {}));
        if (!upstreamVersion) {
            throwEntityNotFound(this.buildInstanceUrl(nodescopeId, packageId, versionId), 'version', versionId);
        }

        const versionData = await this.npmService.getVersionMetadata(packageData.name || '', upstreamVersion);
        if (!versionData) {
            throwEntityNotFound(this.buildInstanceUrl(nodescopeId, packageId, versionId), 'version', versionId);
        }
        return versionData;
    }

    async getPackageMeta(nodescopeId: string, packageId: string): Promise<any> {
        const packageData = await this.getPackage(nodescopeId, packageId);
        return {
            xid: `/nodescopes/${nodescopeId}/packages/${packageId}/meta`,
            name: `${packageData.name}-meta`,
            self: `${this.baseUrl}/nodescopes/${nodescopeId}/packages/${packageId}/meta`,
            readonly: true,
            compatibility: 'strict',
            epoch: 1,
            createdat: packageData.createdat,
            modifiedat: packageData.modifiedat,
            packageData,
        };
    }
}
