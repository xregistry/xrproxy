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
import { modulePathToIdentity } from '../utils/path-escaping';

export class CheckpointService {
    private readonly catalogPath: string;
    private catalog: GoCatalog;
    /** Tracks processed `path@version` pairs so overlapping refetches (which
     *  happen when the index cursor stays at the same timestamp across a
     *  full-page boundary) are not double-counted in `entryCount`. */
    private readonly seen = new Set<string>();

    constructor(cacheDir: string) {
        this.catalogPath = path.join(cacheDir, CATALOG_FILENAME);
        this.catalog = this.loadOrInit();
        this.rebuildSeen();
    }

    // -------------------------------------------------------------------------
    // Persistence helpers
    // -------------------------------------------------------------------------

    /** Populate the dedup set from the catalog loaded off disk. */
    private rebuildSeen(): void {
        this.seen.clear();
        for (const mod of Object.values(this.catalog.modules)) {
            for (const version of mod.versions) {
                this.seen.add(`${mod.path}@${version}`);
            }
        }
    }

    private emptyCatalog(): GoCatalog {
        return {
            schemaVersion: 1,
            generatedAt: new Date().toISOString(),
            checkpoint: {
                since: '2019-04-10T19:08:52.997264Z', // earliest index entry
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

    // -------------------------------------------------------------------------
    // Checkpoint management
    // -------------------------------------------------------------------------

    getCheckpoint(): GoIndexCheckpoint {
        return { ...this.catalog.checkpoint };
    }

    updateCheckpoint(since: string): void {
        this.catalog.checkpoint.since = since;
        this.catalog.checkpoint.savedAt = Date.now();
    }

    // -------------------------------------------------------------------------
    // Module catalog management
    // -------------------------------------------------------------------------

    /**
     * Merge a batch of new index entries into the catalog.
     *
     * Idempotent: entries whose `path@version` pair has already been processed
     * (either earlier in this run or loaded from a persisted catalog) are
     * skipped so a stationary index cursor cannot inflate `entryCount`.
     *
     * @returns the number of genuinely new entries merged.
     */
    mergeEntries(entries: Array<{ path: string; version: string; timestamp: string }>): number {
        let newCount = 0;
        for (const entry of entries) {
            const key = `${entry.path}@${entry.version}`;
            if (this.seen.has(key)) continue;
            this.seen.add(key);

            const existing = this.catalog.modules[entry.path];
            if (existing) {
                if (!existing.versions.includes(entry.version)) {
                    existing.versions.push(entry.version);
                }
                // Track the most recently seen version by timestamp
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
            }
            this.catalog.checkpoint.entryCount++;
            newCount++;
        }
        return newCount;
    }

    /** Return total number of known module paths. */
    getModuleCount(): number {
        return Object.keys(this.catalog.modules).length;
    }

    /** Return the number of distinct module-path namespaces in the catalog. */
    getGroupCount(): number {
        return this.getGroupIds().length;
    }

    /** Retrieve sorted, paginated module-path namespace IDs. */
    listGroupIds(offset: number, limit: number, pattern?: string): {
        groupIds: string[];
        totalKnown: number;
    } {
        const groupIds = pattern
            ? this.filterValues(this.getGroupIds(), pattern)
            : this.getGroupIds();
        return {
            groupIds: groupIds.slice(offset, offset + limit),
            totalKnown: groupIds.length,
        };
    }

    /** Return the number of cataloged modules in one namespace. */
    getGroupModuleCount(groupId: string): number {
        return Object.keys(this.catalog.modules)
            .filter(modulePath => modulePathToIdentity(modulePath).groupId === groupId)
            .length;
    }

    /** Return total number of index entries processed. */
    getEntryCount(): number {
        return this.catalog.checkpoint.entryCount;
    }

    /**
     * Retrieve a paginated, sorted list of module paths.
     * Returns `null` for count when it would be misleading (e.g. mid-refresh).
     */
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

    /** Retrieve modules within one namespace, with optional name filtering. */
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
            .filter(modulePath => modulePathToIdentity(modulePath).groupId === groupId)
            .sort();
        let matched = inGroup;
        if (pattern) {
            matched = this.filterValues(inGroup, pattern);
        }
        return {
            paths: matched.slice(offset, offset + limit),
            totalMatched: matched.length,
        };
    }

    /** Look up a module entry by canonical path. */
    getModule(modulePath: string): GoCatalogModuleEntry | null {
        return this.catalog.modules[modulePath] ?? null;
    }

    /** Check if any modules are loaded. */
    hasModules(): boolean {
        return Object.keys(this.catalog.modules).length > 0;
    }

    /** Filter module paths by a simple substring or glob pattern. */
    filterModulePaths(pattern: string, offset: number, limit: number): {
        paths: string[];
        totalMatched: number;
    } {
        const all = Object.keys(this.catalog.modules).sort();
        let matched: string[];
        matched = this.filterValues(all, pattern);
        return {
            paths: matched.slice(offset, offset + limit),
            totalMatched: matched.length,
        };
    }

    private getGroupIds(): string[] {
        return [...new Set(
            Object.keys(this.catalog.modules).map(modulePath => modulePathToIdentity(modulePath).groupId)
        )].sort();
    }

    private filterValues(values: string[], pattern: string): string[] {
        if (!pattern.includes('*')) {
            const lower = pattern.toLowerCase();
            return values.filter(value => value.toLowerCase().includes(lower));
        }
        const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`^${escaped.replace(/\\\*/g, '.*')}$`, 'i');
        return values.filter(value => regex.test(value));
    }
}
