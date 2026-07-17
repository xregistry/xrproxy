/**
 * Search Service — provider and module catalogue management.
 * Maintains in-memory caches of provider/module IDs and schedules periodic
 * background refreshes from the Terraform Registry.
 */

import { SERVER_CONFIG } from '../config/constants';
import { ModuleEntry, ProviderEntry } from '../types/terraform';
import { TerraformService } from './terraform-service';

export class SearchService {
    private tfService: TerraformService;
    private providerCache: ProviderEntry[] = [];
    private moduleCache: ModuleEntry[] = [];
    private lastProviderRefresh = 0;
    private lastModuleRefresh = 0;
    private readonly refreshInterval: number;
    private refreshTimer?: NodeJS.Timeout;

    constructor(tfService: TerraformService, refreshInterval?: number) {
        this.tfService = tfService;
        this.refreshInterval = refreshInterval ?? SERVER_CONFIG.REFRESH_INTERVAL;
    }

    /** Perform initial load and schedule periodic refreshes */
    async initialize(): Promise<void> {
        console.log('[INFO] Initializing Terraform search service...');
        await Promise.all([this.refreshProviders(), this.refreshModules()]);
        this.schedulePeriodicRefresh();
    }

    private schedulePeriodicRefresh(): void {
        this.refreshTimer = setInterval(async () => {
            await Promise.all([this.refreshProviders(), this.refreshModules()]);
        }, this.refreshInterval);
    }

    stopPeriodicRefresh(): void {
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
            this.refreshTimer = undefined;
        }
    }

    // -----------------------------------------------------------------------
    // Provider catalogue
    // -----------------------------------------------------------------------

    private async refreshProviders(): Promise<void> {
        try {
            // Fetch a representative page (top-100 by downloads covers common usage)
            const entries = await this.tfService.fetchProviderPage(1, 100);
            this.providerCache = entries;
            this.lastProviderRefresh = Date.now();
            console.log(`[INFO] Provider cache refreshed: ${entries.length} entries`);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[ERROR] Provider cache refresh failed: ${msg}`);
        }
    }

    getAllProviders(): ProviderEntry[] {
        return this.providerCache;
    }

    getProviderCount(): number {
        return this.providerCache.length;
    }

    providerInCache(id: string): boolean {
        return this.providerCache.some((p) => p.id === id);
    }

    async providerExists(namespace: string, type: string): Promise<boolean> {
        const id = `${namespace}~${type}`;
        if (this.providerInCache(id)) return true;
        // Fall back to live API check
        const exists = await this.tfService.providerExists(namespace, type);
        if (exists) {
            this.providerCache.push({ namespace, type, id });
        }
        return exists;
    }

    // -----------------------------------------------------------------------
    // Module catalogue
    // -----------------------------------------------------------------------

    private async refreshModules(): Promise<void> {
        try {
            const entries = await this.tfService.fetchModulePage(0, 100);
            this.moduleCache = entries;
            this.lastModuleRefresh = Date.now();
            console.log(`[INFO] Module cache refreshed: ${entries.length} entries`);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[ERROR] Module cache refresh failed: ${msg}`);
        }
    }

    getAllModules(): ModuleEntry[] {
        return this.moduleCache;
    }

    getModuleCount(): number {
        return this.moduleCache.length;
    }

    moduleInCache(id: string): boolean {
        return this.moduleCache.some((m) => m.id === id);
    }

    async moduleExists(namespace: string, name: string, provider: string): Promise<boolean> {
        const id = `${namespace}~${name}~${provider}`;
        if (this.moduleInCache(id)) return true;
        const exists = await this.tfService.moduleExists(namespace, name, provider);
        if (exists) {
            this.moduleCache.push({ namespace, name, provider, id });
        }
        return exists;
    }

    // -----------------------------------------------------------------------
    // Status
    // -----------------------------------------------------------------------

    getCacheStatus(): Record<string, unknown> {
        return {
            providerCount: this.providerCache.length,
            moduleCount: this.moduleCache.length,
            lastProviderRefresh: new Date(this.lastProviderRefresh).toISOString(),
            lastModuleRefresh: new Date(this.lastModuleRefresh).toISOString(),
        };
    }
}
