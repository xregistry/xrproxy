/**
 * Go module proxy TypeScript types.
 */

/** GOPROXY .info response */
export interface GoVersionInfo {
    /** Canonical Go version string */
    Version: string;
    /** RFC 3339 timestamp of the commit that created the version */
    Time: string;
}

/** Entry from the Go module index (index.golang.org/index) */
export interface GoIndexEntry {
    /** Module path (canonical, not escaped) */
    Path: string;
    /** Canonical Go version string */
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

export interface GoChecksumRecord {
    gomodHash?: string;
    zipHash?: string;
}

export interface GoRequireDirective {
    path: string;
    version: string;
    indirect?: boolean;
}

export interface GoReplaceDirective {
    old_path: string;
    old_version?: string;
    new_path: string;
    new_version?: string;
}

export interface GoExcludeDirective {
    path: string;
    version: string;
}

export interface GoRetractDirective {
    low: string;
    high: string;
    rationale?: string;
}

export interface GoEffectiveRetraction extends GoRetractDirective {
    declared_in?: string;
}

export interface ParsedGoMod {
    deprecatedMessage?: string;
    goVersion?: string;
    toolchain?: string;
    require?: GoRequireDirective[];
    replace?: GoReplaceDirective[];
    exclude?: GoExcludeDirective[];
    retract?: GoRetractDirective[];
    godebug?: Record<string, string>;
    tool?: string[];
    ignore?: string[];
}

export interface ModuleMetaRecord {
    latest_version?: string;
    repository?: string;
    major_version_suffix?: string;
    deprecated_message?: string;
    retractions?: GoEffectiveRetraction[];
}

/** Simplified module record returned by the xRegistry service */
export interface ModuleRecord {
    moduleid: string;
    versionid: string;
    isdefault: boolean;
    xid: string;
    name: string;
    version: string;
    modulepath: string;
    self: string;
    epoch: number;
    createdat?: string;
    modifiedat?: string;
    ancestor?: string;
    versionsurl: string;
    versionscount: number;
    meta?: ModuleMetaRecord;
    info_url?: string;
    mod_url?: string;
    zip_url?: string;
    gomod_hash?: string;
    zip_hash?: string;
    pseudo_version?: boolean;
    pre_release?: boolean;
    incompatible?: boolean;
    go_version?: string;
    toolchain?: string;
    require?: GoRequireDirective[];
    replace?: GoReplaceDirective[];
    exclude?: GoExcludeDirective[];
    retract?: GoRetractDirective[];
    godebug?: Record<string, string>;
    tool?: string[];
    ignore?: string[];
}

/** xRegistry version record for a Go module version */
export interface VersionRecord {
    versionid: string;
    isdefault: boolean;
    xid: string;
    self: string;
    epoch: number;
    createdat?: string;
    modifiedat?: string;
    ancestor?: string;
    name: string;
    version: string;
    modulepath: string;
    timestamp?: string;
    info_url?: string;
    mod_url?: string;
    zip_url?: string;
    pseudo_version?: boolean;
    pre_release?: boolean;
    incompatible?: boolean;
    gomod_hash?: string;
    zip_hash?: string;
    go_version?: string;
    toolchain?: string;
    require?: GoRequireDirective[];
    replace?: GoReplaceDirective[];
    exclude?: GoExcludeDirective[];
    retract?: GoRetractDirective[];
    godebug?: Record<string, string>;
    tool?: string[];
    ignore?: string[];
}
