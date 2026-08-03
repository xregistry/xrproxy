/**
 * NuGet API types used by the xRegistry projection.
 */

export interface NuGetSearchResponse {
    totalHits?: number;
    data: NuGetPackageSearchResult[];
}

export interface NuGetPackageSearchResult {
    '@id'?: string;
    id: string;
    version: string;
    description?: string;
    summary?: string;
    title?: string;
    iconUrl?: string;
    readmeUrl?: string;
    licenseUrl?: string;
    licenseExpression?: string;
    projectUrl?: string;
    tags?: string[] | string;
    authors?: string[] | string;
    owners?: string[] | string;
    totalDownloads?: number;
    verified?: boolean;
    packageTypes?: NuGetPackageType[];
    versions?: Array<{ version: string; downloads?: number }>;
}

export interface NuGetRegistrationIndex {
    count: number;
    items: NuGetRegistrationPage[];
}

export interface NuGetRegistrationPage {
    '@id': string;
    count: number;
    lower?: string;
    upper?: string;
    items?: NuGetRegistrationLeaf[];
}

export interface NuGetRegistrationLeaf {
    '@id': string;
    catalogEntry: NuGetCatalogEntry;
    packageContent?: string;
}

export interface NuGetCatalogEntry {
    '@id': string;
    id: string;
    version: string;
    authors?: string | string[];
    dependencyGroups?: NuGetDependencyGroup[];
    deprecation?: NuGetDeprecation;
    description?: string;
    iconUrl?: string;
    readmeUrl?: string;
    language?: string;
    licenseUrl?: string;
    licenseExpression?: string;
    listed?: boolean;
    minClientVersion?: string;
    packageContent?: string;
    packageTypes?: NuGetPackageType[];
    projectUrl?: string;
    published?: string;
    requireLicenseAcceptance?: boolean;
    summary?: string;
    tags?: string[] | string;
    title?: string;
    repository?: NuGetRepository;
    vulnerabilities?: NuGetVulnerability[];
}

export interface NuGetDependencyGroup {
    targetFramework?: string;
    dependencies?: NuGetDependency[];
}

export interface NuGetDependency {
    id: string;
    range?: string;
}

export interface NuGetPackageType {
    name: string;
    version?: string;
}

export interface NuGetRepository {
    type?: string;
    url?: string;
    branch?: string;
    commit?: string;
}

export interface NuGetDeprecation {
    message?: string;
    reasons?: string[];
    alternatePackage?: {
        id?: string;
        range?: string;
    };
}

export interface NuGetVulnerability {
    advisoryUrl?: string;
    severity?: string | number;
}

export interface NuGetCatalogIndex {
    commitId?: string;
    commitTimeStamp?: string;
    count: number;
    items: NuGetCatalogPage[];
}

export interface NuGetCatalogPage {
    '@id': string;
    commitId: string;
    commitTimeStamp: string;
    count: number;
    items?: NuGetCatalogItem[];
}

export interface NuGetCatalogItem {
    '@id': string;
    '@type': string;
    commitId: string;
    commitTimeStamp: string;
    'nuget:id'?: string;
    'nuget:version'?: string;
}

export interface CacheMetadata {
    catalogCursor: string | null;
    lastUpdate: string | null;
    packageNames: string[];
}

export interface CachedResponse<T = unknown> {
    etag: string | null;
    data: T;
    timestamp: number;
}

export interface NuGetServiceIndex {
    version?: string;
    resources?: NuGetServiceIndexResource[];
}

export interface NuGetServiceIndexResource {
    '@id': string;
    '@type': string | string[];
    comment?: string;
}

export interface NuGetRepositorySignatures {
    allRepositorySigned?: boolean;
    signingCertificates?: NuGetRepositorySigningCertificate[];
}

export interface NuGetRepositorySigningCertificate {
    subject?: string;
    issuer?: string;
    fingerprints?: Record<string, string>;
    notBefore?: string;
    notAfter?: string;
    contentUrl?: string;
}
