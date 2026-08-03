/**
 * TypeScript definitions for the xRegistry npm projection.
 */

export interface XRegistryEntity {
    xid: string;
    self: string;
    epoch: number;
    createdat: string;
    modifiedat: string;
    name?: string | undefined;
    description?: string | undefined;
    labels?: Record<string, string>;
    documentation?: string | undefined;
    shortself?: string | undefined;
    [key: string]: any;
}

export interface Person {
    name?: string | undefined;
    email?: string | undefined;
    url?: string | undefined;
}

export interface DependencyReference {
    name: string;
    version?: string | undefined;
    package?: string;
}

export interface BundleDependencyReference {
    name: string;
    package?: string;
}

export interface DistMetadata {
    tarball: string;
    shasum?: string;
    integrity?: string;
    file_count?: number;
    unpacked_size?: number;
    'npm-signature'?: string;
}

export interface Registry extends XRegistryEntity {
    specversion: string;
    registryid: string;
    modelurl?: string | undefined;
    capabilitiesurl?: string | undefined;
    nodescopesurl: string;
    nodescopescount: number;
    nodescopes?: Record<string, Group>;
    model?: unknown;
    capabilities?: unknown;
    modelsource?: unknown;
}

export interface Group extends XRegistryEntity {
    nodescopeid: string;
    scope?: string;
    sourceurl?: string | undefined;
    packagesurl: string;
    packagescount: number;
    packages?: Record<string, Resource>;
}

export interface Resource extends XRegistryEntity {
    packageid: string;
    versionid?: string;
    version?: string | undefined;
    ancestor?: string | undefined;
    dist?: DistMetadata | undefined;
    license?: string | undefined;
    author?: Person;
    homepage?: string | undefined;
    repository?: Record<string, unknown> | undefined;
    bugs?: Record<string, unknown> | undefined;
    engines?: Record<string, string> | undefined;
    os?: string[] | undefined;
    cpu?: string[] | undefined;
    keywords?: string[] | undefined;
    maintainers?: Person[] | undefined;
    contributors?: Person[] | undefined;
    'dist-tags'?: Record<string, string> | undefined;
    deprecated_message?: string | undefined;
    deprecated?: Record<string, unknown> | undefined;
    dependencies?: DependencyReference[] | undefined;
    dev_dependencies?: DependencyReference[] | undefined;
    peer_dependencies?: DependencyReference[] | undefined;
    optional_dependencies?: DependencyReference[] | undefined;
    bundle_dependencies?: BundleDependencyReference[] | undefined;
    replacedby?: string | undefined;
    versionsurl?: string | undefined;
    versionscount?: number | undefined;
    versions?: Record<string, VersionMetadata> | undefined;
    metaurl?: string | undefined;
    meta?: unknown;
}

export interface Version extends XRegistryEntity {
    versionid: string;
    version?: string | undefined;
    packageid?: string;
    ancestor?: string | undefined;
    isdefault?: boolean;
}

export interface VersionMetadata extends Version {
    name: string;
    packageid: string;
    dist: DistMetadata;
    license?: string | undefined;
    author?: Person;
    homepage?: string | undefined;
    repository?: Record<string, unknown> | undefined;
    bugs?: Record<string, unknown> | undefined;
    engines?: Record<string, string> | undefined;
    os?: string[] | undefined;
    cpu?: string[] | undefined;
    keywords?: string[] | undefined;
    maintainers?: Person[] | undefined;
    contributors?: Person[] | undefined;
    'dist-tags'?: Record<string, string> | undefined;
    deprecated_message?: string | undefined;
    deprecated?: Record<string, unknown> | undefined;
    dependencies?: DependencyReference[] | undefined;
    dev_dependencies?: DependencyReference[] | undefined;
    peer_dependencies?: DependencyReference[] | undefined;
    optional_dependencies?: DependencyReference[] | undefined;
    bundle_dependencies?: BundleDependencyReference[] | undefined;
    replacedby?: string | undefined;
}

export interface Meta extends XRegistryEntity {
    readonly: boolean;
    compatibility: string;
    defaultversionid?: string;
    defaultversionurl?: string | undefined;
    defaultversionsticky?: boolean;
}

export interface ErrorResponse {
    type: string;
    title: string;
    status: number;
    instance: string;
    detail?: string;
    data?: any;
}

export interface FilterExpression {
    attribute: string;
    operator: string;
    value: string;
}

export interface PaginationInfo {
    page: number;
    limit: number;
    total: number;
    pages: number;
}

export interface XRegistryGroupResponse {
    [key: string]: Record<string, XRegistryEntity>;
}

export interface XRegistryResourceResponse {
    [key: string]: Record<string, XRegistryEntity>;
}

export interface CacheStats {
    hitCount: number;
    missCount: number;
    hitRate: number;
    size: number;
    maxSize: number;
}

export type SortDirection = 'asc' | 'desc';

export interface SortParams {
    attribute: string;
    direction: SortDirection;
}

export interface InlineParams {
    depth: number;
    attributes: string[];
}

export interface PackageMetadata extends Resource {
    dist?: DistMetadata | undefined;
    versions: Record<string, any>;
    time: Record<string, string>;
    readme?: string | undefined;
    readmeFilename?: string | undefined;
}
