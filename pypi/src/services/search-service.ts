/**
 * Search and package enumeration service.
 */

import { v4 as uuidv4 } from 'uuid';
import { SERVER_CONFIG } from '../config/constants';
import { PackageNameEntry } from '../types/pypi';
import { normalizePackageId } from '../utils/identity';
import { PyPIService } from './pypi-service';

export class SearchService {
    private pypiService: PyPIService;
    private packageNamesCache: PackageNameEntry[] = [];
    private lastRefreshTime = 0;
    private refreshInterval: number;
    private refreshTimer?: NodeJS.Timeout;

    constructor(pypiService: PyPIService, refreshInterval?: number) {
        this.pypiService = pypiService;
        this.refreshInterval = refreshInterval || SERVER_CONFIG.REFRESH_INTERVAL;
    }

    async initialize(): Promise<void> {
        console.log('[INFO] Initializing PyPI search service...');
        await this.refreshPackageNames();
        this.schedulePeriodicRefresh();
    }

    async refreshPackageNames(): Promise<boolean> {
        const operationId = uuidv4();
        console.log('[INFO] Refreshing PyPI package names cache...', {
            operationId,
            refreshInterval: this.refreshInterval,
        });

        try {
            const startTime = Date.now();
            const packages = await this.pypiService.fetchAllPackageNames();

            this.packageNamesCache = packages;
            this.lastRefreshTime = Date.now();

            console.log('[INFO] PyPI package names loaded successfully', {
                operationId,
                packageCount: this.packageNamesCache.length,
                duration: Date.now() - startTime,
                lastRefreshTime: new Date(this.lastRefreshTime).toISOString(),
            });

            return true;
        } catch (error: any) {
            console.error('[ERROR] Error refreshing PyPI package names', {
                operationId,
                error: error.message,
                currentCacheSize: this.packageNamesCache.length,
            });

            return false;
        }
    }

    private schedulePeriodicRefresh(): void {
        this.refreshTimer = setInterval(async () => {
            await this.refreshPackageNames();
        }, this.refreshInterval);
    }

    stopPeriodicRefresh(): void {
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
            this.refreshTimer = undefined;
        }
    }

    getAllPackages(): PackageNameEntry[] {
        return this.packageNamesCache;
    }

    getPackageCount(): number {
        return this.packageNamesCache.length;
    }

    packageExistsInCache(packageName: string): boolean {
        const packageId = normalizePackageId(packageName);
        return this.packageNamesCache.some((pkg) => pkg.name === packageId);
    }

    async packageExists(packageName: string): Promise<boolean> {
        const packageId = normalizePackageId(packageName);

        if (this.packageExistsInCache(packageId)) {
            return true;
        }

        const exists = await this.pypiService.packageExists(packageId);

        if (exists && !this.packageExistsInCache(packageId)) {
            this.packageNamesCache.push({ name: packageId });
            this.packageNamesCache.sort((a, b) => a.name.localeCompare(b.name));
            console.log('[INFO] Package dynamically added to PyPI cache', {
                packageName: packageId,
                newCacheSize: this.packageNamesCache.length,
            });
        }

        return exists;
    }

    getCacheStatus(): {
        packageCount: number;
        lastRefreshTime: string;
        isStale: boolean;
    } {
        const maxAge = 60000;
        const isStale =
            this.packageNamesCache.length === 0 ||
            Date.now() - this.lastRefreshTime > maxAge;

        return {
            packageCount: this.packageNamesCache.length,
            lastRefreshTime: new Date(this.lastRefreshTime).toISOString(),
            isStale,
        };
    }

    async forceRefresh(): Promise<boolean> {
        return this.refreshPackageNames();
    }
}
