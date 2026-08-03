/**
 * Packagist-specific types returned by the upstream API
 */

export interface PackagistPackageInfo {
    package: PackagistPackage;
}

export interface PackagistPackage {
    name: string;
    description: string;
    time?: string;
    maintainers?: PackagistMaintainer[];
    versions: Record<string, PackagistVersion>;
    type?: string;
    repository?: string;
    github_stars?: number;
    github_watchers?: number;
    github_forks?: number;
    github_open_issues?: number;
    language?: string;
    dependents?: number;
    suggesters?: number;
    downloads?: PackagistDownloads;
    favers?: number;
    readme?: string;
    default_branch?: string;
}

export interface PackagistMaintainer {
    name: string;
    avatar_url?: string;
}

export interface PackagistDownloads {
    total: number;
    monthly: number;
    daily: number;
}

export interface PackagistVersion {
    name: string;
    description?: string;
    keywords?: string[];
    homepage?: string;
    version: string;
    version_normalized: string;
    license?: string[];
    authors?: PackagistAuthor[];
    source?: PackagistSource;
    dist?: PackagistDist;
    type?: string;
    time?: string;
    autoload?: Record<string, unknown>;
    'autoload-dev'?: Record<string, unknown>;
    bin?: string[];
    scripts?: Record<string, unknown> | string[] | string;
    support?: PackagistSupport;
    extra?: Record<string, unknown>;
    require?: Record<string, string>;
    'require-dev'?: Record<string, string>;
    conflict?: Record<string, string>;
    replace?: Record<string, string>;
    provide?: Record<string, string>;
    suggest?: Record<string, string>;
    abandoned?: string | boolean;
    funding?: PackagistFunding[];
}

export interface PackagistAuthor {
    name?: string;
    email?: string;
    homepage?: string;
    role?: string;
}

export interface PackagistSource {
    url?: string;
    type?: string;
    reference?: string;
}

export interface PackagistDist {
    url?: string;
    type?: string;
    shasum?: string;
    reference?: string;
}

export interface PackagistSupport {
    email?: string;
    issues?: string;
    forum?: string;
    wiki?: string;
    irc?: string;
    chat?: string;
    source?: string;
    docs?: string;
    rss?: string;
    security?: string;
}

export interface PackagistFunding {
    url?: string;
    type?: string;
}

export interface PackagistSearchResult {
    results: PackagistSearchHit[];
    total: number;
    next?: string;
}

export interface PackagistSearchHit {
    name: string;
    description?: string;
    url?: string;
    repository?: string;
    downloads?: number;
    favers?: number;
    abandoned?: string | boolean;
}

export interface PackagistPackageListResult {
    packageNames?: string[];
    /** v2 API uses `packages` key */
    packages?: string[];
}
