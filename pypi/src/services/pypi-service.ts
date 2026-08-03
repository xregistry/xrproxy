/**
 * PyPI API integration service.
 */

import { FALLBACK_PACKAGES, PYPI_API } from '../config/constants';
import {
    PackageMetadata,
    PackageNameEntry,
    PyPIPackageResponse,
    PyPISimpleProjectResponse,
    PyPISimpleResponse,
} from '../types/pypi';
import { normalizePackageId } from '../utils/identity';
import { CacheService } from './cache-service';

export class PyPIService {
    private cacheService: CacheService;

    constructor(cacheService: CacheService) {
        this.cacheService = cacheService;
    }

    async fetchAllPackageNames(): Promise<PackageNameEntry[]> {
        try {
            const response = await this.cacheService.cachedGet<PyPISimpleResponse>(
                PYPI_API.SIMPLE_URL,
                { Accept: PYPI_API.SIMPLE_ACCEPT_HEADER }
            );

            if (response?.projects && Array.isArray(response.projects)) {
                const unique = new Set<string>();
                for (const project of response.projects) {
                    unique.add(normalizePackageId(project.name));
                }

                return Array.from(unique)
                    .sort((a, b) => a.localeCompare(b))
                    .map((name) => ({ name }));
            }

            throw new Error('PyPI API did not return a valid projects array');
        } catch (error: any) {
            console.error('Error fetching PyPI package names:', error.message);
            return FALLBACK_PACKAGES.map((name) => ({ name })).sort((a, b) =>
                a.name.localeCompare(b.name)
            );
        }
    }

    async fetchPackageMetadata(packageName: string): Promise<PyPIPackageResponse> {
        const packageId = normalizePackageId(packageName);
        const url = `${PYPI_API.JSON_API_URL}/${packageId}/json`;
        return this.cacheService.cachedGet<PyPIPackageResponse>(url);
    }

    async fetchVersionMetadata(
        packageName: string,
        version: string
    ): Promise<PyPIPackageResponse> {
        const packageId = normalizePackageId(packageName);
        const url = `${PYPI_API.JSON_API_URL}/${packageId}/${encodeURIComponent(version)}/json`;
        return this.cacheService.cachedGet<PyPIPackageResponse>(url);
    }

    async fetchSimpleProject(packageName: string): Promise<PyPISimpleProjectResponse> {
        const packageId = normalizePackageId(packageName);
        const url = `${PYPI_API.SIMPLE_URL}${packageId}/`;
        return this.cacheService.cachedGet<PyPISimpleProjectResponse>(url, {
            Accept: PYPI_API.SIMPLE_ACCEPT_HEADER,
        });
    }

    async fetchSimplifiedMetadata(packageName: string): Promise<PackageMetadata> {
        try {
            const packageData = await this.fetchPackageMetadata(packageName);
            const info = packageData.info || {};

            return {
                name: normalizePackageId(packageName),
                description: info.summary || info.description || '',
                author: (info.author || info.maintainer || '') as string,
                license: (info.license_expression || info.license || '') as string,
                homepage: (info.home_page || info.project_url || '') as string,
                keywords: info.keywords
                    ? info.keywords.split(',').map((k) => k.trim()).filter(Boolean)
                    : [],
                version: info.version || '',
                classifiers: info.classifiers || [],
                project_urls: info.project_urls || {},
            };
        } catch {
            return {
                name: normalizePackageId(packageName),
                description: '',
                author: '',
                license: '',
                homepage: '',
                keywords: [],
                version: '',
                classifiers: [],
                project_urls: {},
            };
        }
    }

    async packageExists(packageName: string): Promise<boolean> {
        try {
            await this.fetchPackageMetadata(packageName);
            return true;
        } catch {
            return false;
        }
    }

    async getPackageVersions(packageName: string): Promise<string[]> {
        const [packageData, simpleProject] = await Promise.all([
            this.fetchPackageMetadata(packageName),
            this.fetchSimpleProject(packageName),
        ]);

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

    async getLatestVersion(packageName: string): Promise<string> {
        const packageData = await this.fetchPackageMetadata(packageName);
        return packageData.info.version;
    }
}
