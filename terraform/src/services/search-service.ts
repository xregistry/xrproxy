import { isUpstreamError } from '@xregistry/registry-core';
/** In-memory discovery catalogue for the fixed Terraform registry host. */

import { decodeModuleIdentity, decodeProviderIdentity, encodeModuleId, SERVER_CONFIG } from '../config/constants';
import { ModuleEntry, ProviderEntry } from '../types/terraform';
import { TerraformService } from './terraform-service';

export interface TerraformNamespaceSummary {
    namespace: string;
    providerscount: number;
    modulescount: number;
}

function preferredCase(current: string, candidate: string): string {
    if (current === candidate) return current;
    const currentLower = current === current.toLowerCase();
    const candidateLower = candidate === candidate.toLowerCase();
    if (currentLower !== candidateLower) return candidateLower ? candidate : current;
    return current.localeCompare(candidate) <= 0 ? current : candidate;
}

export class SearchService {
    private providerCache: ProviderEntry[] = [];
    private moduleCache: ModuleEntry[] = [];
    private readonly resolvedProviders = new Map<string, ProviderEntry>();
    private readonly resolvedModules = new Map<string, ModuleEntry>();
    private readonly resolvedNamespaces = new Map<string, string>();
    private lastProviderRefresh = 0;
    private lastModuleRefresh = 0;
    private readonly refreshInterval: number;
    private refreshTimer?: NodeJS.Timeout;

    constructor(private readonly tfService: TerraformService, refreshInterval?: number) {
        this.refreshInterval = refreshInterval ?? SERVER_CONFIG.REFRESH_INTERVAL;
    }

    async initialize(): Promise<void> {
        console.log('[INFO] Initializing Terraform search service...');
        await Promise.all([this.refreshProviders(), this.refreshModules()]);
        this.schedulePeriodicRefresh();
    }

    private schedulePeriodicRefresh(): void {
        this.refreshTimer = setInterval(async () => {
            await Promise.all([this.refreshProviders(), this.refreshModules()]);
        }, this.refreshInterval);
        this.refreshTimer.unref?.();
    }

    stopPeriodicRefresh(): void {
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
            this.refreshTimer = undefined;
        }
    }

    private async refreshProviders(): Promise<void> {
        try {
            const discovered = await this.tfService.fetchProviderPage(1, 100);
            this.providerCache = this.mergeProviders(discovered, [...this.resolvedProviders.values()]);
            this.lastProviderRefresh = Date.now();
            console.log(`[INFO] Provider cache refreshed: ${this.providerCache.length} entries`);
        } catch (error) {
            console.error(`[ERROR] Provider cache refresh failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private async refreshModules(): Promise<void> {
        try {
            const discovered = await this.tfService.fetchModulePage(0, 100);
            this.moduleCache = this.mergeModules(discovered, [...this.resolvedModules.values()]);
            this.lastModuleRefresh = Date.now();
            console.log(`[INFO] Module cache refreshed: ${this.moduleCache.length} entries`);
        } catch (error) {
            console.error(`[ERROR] Module cache refresh failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private mergeProviders(...collections: readonly ProviderEntry[][]): ProviderEntry[] {
        const merged = new Map<string, ProviderEntry>();
        for (const candidate of collections.flat()) {
            const key = `${candidate.namespace}/${candidate.type}`.toLowerCase();
            const current = merged.get(key);
            if (!current) {
                merged.set(key, candidate);
                continue;
            }
            const namespace = preferredCase(current.namespace, candidate.namespace);
            const type = preferredCase(current.type, candidate.type);
            merged.set(key, namespace === candidate.namespace && type === candidate.type ? candidate : { ...current, namespace, type, id: type });
        }
        return [...merged.values()].sort((a, b) =>
            a.namespace.localeCompare(b.namespace, undefined, { sensitivity: 'base' }) ||
            a.type.localeCompare(b.type, undefined, { sensitivity: 'base' }) ||
            a.namespace.localeCompare(b.namespace) || a.type.localeCompare(b.type),
        );
    }

    private mergeModules(...collections: readonly ModuleEntry[][]): ModuleEntry[] {
        const merged = new Map<string, ModuleEntry>();
        for (const candidate of collections.flat()) {
            const key = `${candidate.namespace}/${candidate.name}/${candidate.provider}`.toLowerCase();
            const current = merged.get(key);
            if (!current) {
                merged.set(key, candidate);
                continue;
            }
            const namespace = preferredCase(current.namespace, candidate.namespace);
            const name = preferredCase(current.name, candidate.name);
            const provider = preferredCase(current.provider, candidate.provider);
            merged.set(key, { ...current, namespace, name, provider, id: encodeModuleId(name, provider) });
        }
        return [...merged.values()].sort((a, b) =>
            a.namespace.localeCompare(b.namespace, undefined, { sensitivity: 'base' }) ||
            a.id.localeCompare(b.id, undefined, { sensitivity: 'base' }) ||
            a.namespace.localeCompare(b.namespace) || a.id.localeCompare(b.id),
        );
    }

    private rememberNamespace(namespace: string): void {
        const key = namespace.toLowerCase();
        const current = this.resolvedNamespaces.get(key);
        this.resolvedNamespaces.set(key, current ? preferredCase(current, namespace) : namespace);
    }

    registerProvider(namespace: string, type: string): void {
        const entry = { namespace, type, id: type };
        this.resolvedProviders.set(`${namespace}/${type}`.toLowerCase(), entry);
        this.rememberNamespace(namespace);
        this.providerCache = this.mergeProviders(this.providerCache, [entry]);
    }

    registerModule(namespace: string, name: string, provider: string): void {
        const entry = { namespace, name, provider, id: encodeModuleId(name, provider) };
        this.resolvedModules.set(`${namespace}/${name}/${provider}`.toLowerCase(), entry);
        this.rememberNamespace(namespace);
        this.moduleCache = this.mergeModules(this.moduleCache, [entry]);
    }

    isDiscoveryComplete(): boolean { return false; }

    getAllProviders(): ProviderEntry[] { return [...this.providerCache]; }
    getAllModules(): ModuleEntry[] { return [...this.moduleCache]; }
    getProviders(namespace: string): ProviderEntry[] {
        return this.providerCache.filter(entry => entry.namespace.toLowerCase() === namespace.toLowerCase());
    }
    getModules(namespace: string): ModuleEntry[] {
        return this.moduleCache.filter(entry => entry.namespace.toLowerCase() === namespace.toLowerCase());
    }
    getProviderCount(namespace?: string): number { return namespace ? this.getProviders(namespace).length : this.providerCache.length; }
    getModuleCount(namespace?: string): number { return namespace ? this.getModules(namespace).length : this.moduleCache.length; }

    getNamespaces(): TerraformNamespaceSummary[] {
        const summaries = new Map<string, TerraformNamespaceSummary>();
        const add = (namespace: string, kind: 'providerscount' | 'modulescount'): void => {
            const key = namespace.toLowerCase();
            const current = summaries.get(key) ?? { namespace, providerscount: 0, modulescount: 0 };
            current.namespace = preferredCase(current.namespace, namespace);
            current[kind] += 1;
            summaries.set(key, current);
        };
        for (const provider of this.providerCache) add(provider.namespace, 'providerscount');
        for (const module of this.moduleCache) add(module.namespace, 'modulescount');
        for (const namespace of this.resolvedNamespaces.values()) {
            const key = namespace.toLowerCase();
            summaries.set(key, summaries.get(key) ?? { namespace, providerscount: 0, modulescount: 0 });
        }
        return [...summaries.values()].sort((a, b) =>
            a.namespace.localeCompare(b.namespace, undefined, { sensitivity: 'base' }) || a.namespace.localeCompare(b.namespace),
        );
    }

    namespaceInCache(namespace: string): boolean {
        return this.getNamespaces().some(entry => entry.namespace.toLowerCase() === namespace.toLowerCase());
    }

    async resolveNamespace(namespace: string): Promise<TerraformNamespaceSummary | null> {
        const cached = this.getNamespaces().find(entry => entry.namespace.toLowerCase() === namespace.toLowerCase());
        if (cached) return cached;
        const canonical = await this.tfService.findNamespace(namespace);
        if (!canonical) return null;
        this.rememberNamespace(canonical);
        return { namespace: canonical, providerscount: this.getProviders(canonical).length, modulescount: this.getModules(canonical).length };
    }

    providerInCache(namespace: string, type: string): boolean {
        return this.providerCache.some(entry =>
            entry.namespace.toLowerCase() === namespace.toLowerCase() && entry.type.toLowerCase() === type.toLowerCase(),
        );
    }

    async providerExists(namespace: string, type: string): Promise<boolean> {
        const cached = this.providerCache.find(entry =>
            entry.namespace.toLowerCase() === namespace.toLowerCase() && entry.type.toLowerCase() === type.toLowerCase(),
        );
        if (cached) return cached.namespace === namespace && cached.type === type;
        let response;
        try {
            response = await this.tfService.fetchProviderVersions(namespace, type);
        } catch (error) {
            if (isUpstreamError(error) && error.code === 'not_found') return false;
            throw error;
        }
        const parts = response.id.split('/');
        const canonical = parts.length === 2 ? decodeProviderIdentity(parts[0] ?? '', parts[1] ?? '') : null;
        if (!canonical) return false;
        if (canonical.namespace !== namespace || canonical.type !== type) return false;
        this.registerProvider(canonical.namespace, canonical.type);
        return true;
    }

    moduleInCache(namespace: string, name: string, provider: string): boolean {
        return this.moduleCache.some(entry =>
            entry.namespace.toLowerCase() === namespace.toLowerCase() &&
            entry.name.toLowerCase() === name.toLowerCase() &&
            entry.provider.toLowerCase() === provider.toLowerCase(),
        );
    }

    async moduleExists(namespace: string, name: string, provider: string): Promise<boolean> {
        const cached = this.moduleCache.find(entry =>
            entry.namespace.toLowerCase() === namespace.toLowerCase() &&
            entry.name.toLowerCase() === name.toLowerCase() &&
            entry.provider.toLowerCase() === provider.toLowerCase(),
        );
        if (cached) return cached.namespace === namespace && cached.name === name && cached.provider === provider;
        let response;
        try {
            response = await this.tfService.fetchModuleVersions(namespace, name, provider);
        } catch (error) {
            if (isUpstreamError(error) && error.code === 'not_found') return false;
            throw error;
        }
        const source = response.modules?.[0]?.source;
        const parts = source?.split('/') ?? [];
        const canonical = parts.length === 3
            ? decodeModuleIdentity(parts[0] ?? '', encodeModuleId(parts[1] ?? '', parts[2] ?? ''))
            : null;
        if (!canonical) return false;
        if (canonical.namespace !== namespace || canonical.name !== name || canonical.provider !== provider) return false;
        this.registerModule(canonical.namespace, canonical.name, canonical.provider);
        return true;
    }

    getCacheStatus(): Record<string, unknown> {
        return {
            providerCount: this.providerCache.length,
            moduleCount: this.moduleCache.length,
            namespaceCount: this.getNamespaces().length,
            lastProviderRefresh: new Date(this.lastProviderRefresh).toISOString(),
            lastModuleRefresh: new Date(this.lastModuleRefresh).toISOString(),
        };
    }
}
