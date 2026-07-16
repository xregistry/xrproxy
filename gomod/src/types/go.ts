/**
 * Go module proxy TypeScript types
 */

/** GOPROXY .info response */
export interface GoVersionInfo {
    /** Semantic version string */
    Version: string;
    /** RFC 3339 timestamp of the commit that created the version */
    Time: string;
}

/** Entry from the Go module index (index.golang.org/index) */
export interface GoIndexEntry {
    /** Module path (canonical, not escaped) */
    Path: string;
    /** Version string */
    Version: string;
    /** RFC 3339 timestamp */
    Timestamp: string;
}

/** Persisted checkpoint for the Go index */
export interface GoIndexCheckpoint {
    /** RFC 3339 timestamp used as the `since` cursor for the next fetch */
    since: string;
    /** Unix millis when the checkpoint was last saved */
    savedAt: number;
    /** Total number of entries accumulated so far */
    entryCount: number;
}

/** Catalog entry stored in the provider-neutral catalog file */
export interface GoCatalogEntry {
    path: string;
    version: string;
    timestamp: string;
}

/** Persisted provider-neutral module catalog */
export interface GoCatalog {
    schemaVersion: number;
    /** RFC 3339 timestamp of when this catalog was generated */
    generatedAt: string;
    /** Index cursor used to generate this snapshot */
    checkpoint: GoIndexCheckpoint;
    /** Modules indexed so far, keyed by module path */
    modules: Record<string, GoCatalogModuleEntry>;
}

/** Per-module entry in the provider-neutral catalog */
export interface GoCatalogModuleEntry {
    /** Canonical module path */
    path: string;
    /** Most recently seen version */
    latestVersion: string;
    /** All known versions in ascending order */
    versions: string[];
    /** RFC 3339 timestamp of the most recently seen index entry */
    lastSeen: string;
}

/** Simplified module record returned by the xRegistry service */
export interface ModuleRecord {
    moduleid: string;
    xid: string;
    name: string;
    self: string;
    epoch: number;
    createdat: string;
    modifiedat: string;
    versionsurl: string;
    versionscount: number;
    latest_version: string;
    repository: string;
    info_url: string;
    mod_url: string;
    zip_url: string;
    pseudo_version: boolean;
    pre_release: boolean;
}

/** xRegistry version record for a Go module version */
export interface VersionRecord {
    versionid: string;
    xid: string;
    self: string;
    epoch: number;
    createdat: string;
    modifiedat: string;
    name: string;
    version: string;
    timestamp: string;
    info_url: string;
    mod_url: string;
    zip_url: string;
    pseudo_version: boolean;
    pre_release: boolean;
    gomod_hash: string | null;
    zip_hash: string | null;
}
