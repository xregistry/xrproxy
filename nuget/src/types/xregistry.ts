/**
 * xRegistry type definitions for the NuGet projection.
 */

export interface XRegistryEntity {
    xid: string;
    self: string;
    epoch: number;
    createdat: string;
    modifiedat: string;
    name?: string;
    description?: string;
    documentation?: string;
    labels?: Record<string, string>;
    shortself?: string;
    [key: string]: unknown;
}

export interface Registry extends XRegistryEntity {
    specversion: string;
    registryid: string;
    modelurl: string;
    capabilitiesurl: string;
    dotnetregistriesurl: string;
    dotnetregistriescount: number;
    dotnetregistries?: Record<string, Group>;
    capabilities?: Record<string, unknown>;
    model?: Record<string, unknown>;
    modelsource?: Record<string, unknown>;
}

export interface Group extends XRegistryEntity {
    dotnetregistryid: string;
    sourceurl?: string;
    all_repository_signed?: boolean;
    repository_signing_certificates?: RepositorySigningCertificate[];
    packagesurl: string;
    packagescount: number;
    packages?: Record<string, Resource>;
}

export interface RepositorySigningCertificate {
    subject?: string;
    issuer?: string;
    fingerprint_sha256?: string;
    not_before?: string;
    not_after?: string;
    content_url?: string;
}

export interface PackageType {
    name: string;
    version?: string;
}

export interface PackageRepository {
    type?: string;
    url?: string;
    branch?: string;
    commit?: string;
}

export interface PackageAlternate {
    id?: string;
    range?: string;
    package?: string;
}

export interface PackageDeprecation {
    reasons?: string[];
    message?: string;
    alternate_package?: PackageAlternate;
}

export interface PackageVulnerability {
    advisory_url?: string;
    severity?: number;
}

export interface PackageDependency {
    name: string;
    range?: string;
    target_framework?: string;
    package?: string;
    resolved_version?: string;
}

export interface ResourceAttributes {
    version?: string;
    title?: string;
    authors?: string[];
    summary?: string;
    language?: string;
    icon_url?: string;
    readme_url?: string;
    license_url?: string;
    license_expression?: string;
    require_license_acceptance?: boolean;
    project_url?: string;
    package_content?: string;
    min_client_version?: string;
    listed?: boolean;
    published?: string;
    tags?: string[];
    package_types?: PackageType[];
    repository?: PackageRepository;
    deprecation?: PackageDeprecation;
    vulnerabilities?: PackageVulnerability[];
    dependencies?: PackageDependency[];
}

export interface Resource extends XRegistryEntity, ResourceAttributes {
    packageid: string;
    versionid: string;
    ancestor: string;
    metaurl: string;
    versionsurl: string;
    versionscount: number;
    meta?: Meta;
    versions?: Record<string, Version>;
}

export interface Version extends XRegistryEntity, ResourceAttributes {
    versionid: string;
    ancestor: string;
    packageid?: string;
}

export interface Meta extends XRegistryEntity {
    packageid: string;
    defaultversionid?: string;
    defaultversionurl?: string;
    defaultversionsticky?: boolean;
    owners?: string[];
    total_downloads?: number;
    verified?: boolean;
}

export interface ErrorResponse {
    type: string;
    title: string;
    status: number;
    instance: string;
    detail?: string;
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
    [key: string]: XRegistryEntity[];
}

export interface XRegistryResourceResponse {
    [key: string]: XRegistryEntity[];
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

export type PackageMetadata = Resource;
export type VersionMetadata = Version;
