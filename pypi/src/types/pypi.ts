/**
 * PyPI-specific type definitions
 * Based on the PyPI JSON and Simple APIs.
 */

export interface PackageNameEntry {
    name: string;
}

export interface PyPISimpleProject {
    name: string;
}

export interface PyPISimpleResponse {
    meta: {
        'api-version': string;
    };
    projects: PyPISimpleProject[];
}

export interface PyPISimpleProjectStatus {
    status?: string;
    reason?: string;
    'replaced-by'?: string;
    replaced_by?: string;
}

export interface PyPISimpleFile {
    'core-metadata'?: boolean | Record<string, string> | null;
    'data-dist-info-metadata'?: boolean | Record<string, string> | null;
    filename: string;
    hashes?: Record<string, string>;
    provenance?: string | null;
    'requires-python'?: string | null;
    size?: number;
    'upload-time'?: string;
    url: string;
    yanked?: boolean;
}

export interface PyPISimpleProjectResponse {
    files: PyPISimpleFile[];
    meta: {
        'api-version': string;
        '_last-serial'?: number;
    };
    name: string;
    'project-status'?: PyPISimpleProjectStatus;
    versions?: string[];
}

export interface PyPIPackageInfo {
    author?: string | null;
    author_email?: string | null;
    bugtrack_url?: string | null;
    classifiers?: string[];
    description?: string | null;
    description_content_type?: string | null;
    docs_url?: string | null;
    download_url?: string | null;
    downloads?: {
        last_day: number;
        last_month: number;
        last_week: number;
    };
    dynamic?: string[];
    home_page?: string | null;
    keywords?: string | null;
    license?: string | null;
    license_expression?: string | null;
    license_files?: string[];
    maintainer?: string | null;
    maintainer_email?: string | null;
    name: string;
    package_url: string;
    platform?: string | null;
    project_url?: string | null;
    project_urls?: Record<string, string> | null;
    provides_extra?: string[];
    release_url?: string | null;
    requires_dist?: string[];
    requires_python?: string | null;
    summary?: string | null;
    version: string;
    yanked?: boolean;
    yanked_reason?: string | null;
    [key: string]: unknown;
}

export interface PyPIPackageFile {
    comment_text?: string;
    'core-metadata'?: boolean | Record<string, string> | null;
    digests: {
        md5?: string;
        sha256?: string;
        blake2b_256?: string;
        [key: string]: string | undefined;
    };
    downloads?: number;
    filename: string;
    has_sig?: boolean;
    md5_digest?: string;
    packagetype?: string;
    python_version?: string;
    requires_python?: string | null;
    size?: number;
    upload_time?: string;
    upload_time_iso_8601?: string;
    url: string;
    yanked?: boolean;
    yanked_reason?: string | null;
}

export interface PyPIVulnerability {
    aliases?: string[];
    details?: string;
    fixed_in?: string[];
    id: string;
    link?: string;
    source?: string;
    summary?: string;
    withdrawn?: string | null;
}

export interface PyPIPackageResponse {
    info: PyPIPackageInfo;
    last_serial: number;
    releases: Record<string, PyPIPackageFile[]>;
    urls: PyPIPackageFile[];
    vulnerabilities?: PyPIVulnerability[];
}

export interface PackageMetadata {
    name: string;
    description: string;
    author: string;
    license: string;
    homepage: string;
    keywords: string[];
    version: string;
    classifiers: string[];
    project_urls: Record<string, string>;
}

export interface CacheEntry<T = unknown> {
    etag: string | null;
    data: T;
    timestamp: number;
}

export interface PyPIServiceConfig {
    simpleApiUrl: string;
    jsonApiUrl: string;
    cacheDir: string;
    refreshInterval: number;
}

export interface SearchServiceConfig {
    cacheSize: number;
    maxCacheAge: number;
    enableTwoStepFiltering: boolean;
    maxMetadataFetches: number;
}
