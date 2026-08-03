/**
 * Checkpoint and provider-neutral catalog persistence for the Go module index.
 *
 * The catalog is stored as a plain JSON file on disk. The schema is
 * intentionally simple so the file can be bundled as a signed OCI artifact
 * without any cloud-provider-specific code.
 */

import * as fs from 'fs';
import * as path from 'path';
import { CATALOG_FILENAME } from '../config/constants';
import {
    GoCatalog,
    GoCatalogModuleEntry,
    GoIndexCheckpoint,
} from '../types/go';
import { ModuleIdentity, modulePathToIdentity } from '../utils/path-escaping';

export class CheckpointService {
    private readonly catalogPath: string;
    private catalog: GoCatalog;
    /** Tracks processed `path@version` pairs so overlapping refetches (which
     *  happen when the index cursor stays at the same timestamp across a
     *  full-page boundary) are not double-counted in `entryCount`. */
    private readonly seen = new Set<string>();
    private identityByPath = new Map<string, ModuleIdentity>();
    private pathByIdentity = new Map<string, string>();
    private groupIds: string[] = [];

    constructor(cacheDir: string) {
        this.catalogPath = path.join(cacheDir, CATALOG_FILENAME);
        this.catalog = this.loadOrInit();
        this.rebuildSeen();
        this.rebuildIdentityMaps();
    }

    /** Populate the dedup set from the catalog loaded off disk. */
    private rebuildSeen(): void {
        this.seen.clear();
        for (const mod of Object.values(this.catalog.modules)) {
            for (const version of mod.versions) {
                this.seen.add(`${mod.path}@${version}`);
            }
        }
    }

    private rebuildIdentityMaps(): void {
        this.identityByPath.clear();
        this.pathByIdentity.clear();

        const modulePaths = Object.keys(this.catalog.modules).sort();
        const groups = new Set<string>();

        for (const modulePath of modulePaths) {
            const identity = modulePathToIdentity(modulePath, { collidingModulePaths: modulePaths });
            this.identityByPath.set(modulePath, identity);
            this.pathByIdentity.set(`${identity.groupId}\u0000${identity.moduleId}`, modulePath);
            groups.add(identity.groupId);
        }

        this.groupIds = [...groups].sort();
    }

    private emptyCatalog(): GoCatalog {
        return {
            schemaVersion: 1,
            generatedAt: new Date().toISOString(),
            checkpoint: {
                since: '2019-04-10T19:08:52.997264Z',
                savedAt: 0,
                entryCount: 0,
            },
            modules: {},
        };
    }

    private loadOrInit(): GoCatalog {
        try {
            if (fs.existsSync(this.catalogPath)) {
                const raw = fs.readFileSync(this.catalogPath, 'utf-8');
                const parsed = JSON.parse(raw) as GoCatalog;
                if (parsed.schemaVersion === 1 && parsed.modules) {
                    return parsed;
                }
            }
        } catch {
            // Corrupt or missing catalog — start fresh
        }
        return this.emptyCatalog();
    }

    /** Persist the current catalog to disk atomically. */
    save(): void {
        const dir = path.dirname(this.catalogPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const tmp = this.catalogPath + '.tmp';
        this.catalog.generatedAt = new Date().toISOString();
        fs.writeFileSync(tmp, JSON.stringify(this.catalog, null, 2), 'utf-8');
        fs.renameSync(tmp, this.catalogPath);
    }

    getCheckpoint(): GoIndexCheckpoint {
        return { ...this.catalog.checkpoint };
    }

    updateCheckpoint(since: string): void {
        this.catalog.checkpoint.since = since;
        this.catalog.checkpoint.savedAt = Date.now();
    }

    mergeEntries(entries: Array<{ path: string; version: string; timestamp: string }>): number {
        let newCount = 0;
        let touchedNewModulePath = false;
        for (const entry of entries) {
            const key = `${entry.path}@${entry.version}`;
            if (this.seen.has(key)) continue;
            this.seen.add(key);

            const existing = this.catalog.modules[entry.path];
            if (existing) {
                if (!existing.versions.includes(entry.version)) {
                    existing.versions.push(entry.version);
                }
                if (entry.timestamp > existing.lastSeen) {
                    existing.latestVersion = entry.version;
                    existing.lastSeen = entry.timestamp;
                }
            } else {
                this.catalog.modules[entry.path] = {
                    path: entry.path,
                    latestVersion: entry.version,
                    versions: [entry.version],
                    lastSeen: entry.timestamp,
                };
                touchedNewModulePath = true;
            }
            this.catalog.checkpoint.entryCount++;
            newCount++;
        }
        if (touchedNewModulePath) {
            this.rebuildIdentityMaps();
        }
        return newCount;
    }

    getModuleCount(): number {
        return Object.keys(this.catalog.modules).length;
    }

    getGroupCount(): number {
        return this.groupIds.length;
    }

    listGroupIds(offset: number, limit: number, pattern?: string): {
        groupIds: string[];
        totalKnown: number;
    } {
        const groupIds = pattern ? this.filterValues(this.groupIds, pattern) : this.groupIds;
        return {
            groupIds: groupIds.slice(offset, offset + limit),
            totalKnown: groupIds.length,
        };
    }

    getGroupModuleCount(groupId: string): number {
        return [...this.identityByPath.values()].filter((identity) => identity.groupId === groupId).length;
    }

    getEntryCount(): number {
        return this.catalog.checkpoint.entryCount;
    }

    listModulePaths(offset: number, limit: number): {
        paths: string[];
        totalKnown: number;
    } {
        const sorted = Object.keys(this.catalog.modules).sort();
        return {
            paths: sorted.slice(offset, offset + limit),
            totalKnown: sorted.length,
        };
    }

    listGroupModulePaths(
        groupId: string,
        pattern: string | undefined,
        offset: number,
        limit: number
    ): {
        paths: string[];
        totalMatched: number;
    } {
        const inGroup = Object.keys(this.catalog.modules)
            .filter((modulePath) => this.getModuleIdentity(modulePath).groupId === groupId)
            .sort();
        const matched = pattern ? this.filterValues(inGroup, pattern) : inGroup;
        return {
            paths: matched.slice(offset, offset + limit),
            totalMatched: matched.length,
        };
    }

    getModule(modulePath: string): GoCatalogModuleEntry | null {
        return this.catalog.modules[modulePath] ?? null;
    }

    getModuleIdentity(modulePath: string): ModuleIdentity {
        const identity = this.identityByPath.get(modulePath);
        if (identity) return identity;
        return modulePathToIdentity(modulePath, {
            collidingModulePaths: [...Object.keys(this.catalog.modules), modulePath],
        });
    }

    resolveModulePath(groupId: string, moduleId: string): string | null {
        return this.pathByIdentity.get(`${groupId}\u0000${moduleId}`) ?? null;
    }

    hasModules(): boolean {
        return Object.keys(this.catalog.modules).length > 0;
    }

    filterModulePaths(pattern: string, offset: number, limit: number): {
        paths: string[];
        totalMatched: number;
    } {
        const all = Object.keys(this.catalog.modules).sort();
        const matched = this.filterValues(all, pattern);
        return {
            paths: matched.slice(offset, offset + limit),
            totalMatched: matched.length,
        };
    }

    private filterValues(values: string[], pattern: string): string[] {
        if (!pattern.includes('*')) {
            const lower = pattern.toLowerCase();
            return values.filter((value) => value.toLowerCase().includes(lower));
        }
        const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`^${escaped.replace(/\\\*/g, '.*')}$`, 'i');
        return values.filter((value) => regex.test(value));
    }
}
