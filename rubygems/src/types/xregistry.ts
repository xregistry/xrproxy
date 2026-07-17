export interface RubyGemDependency {
    name: string;
    requirements: string;
}

export interface RubyGemDependencies {
    development: RubyGemDependency[];
    runtime: RubyGemDependency[];
}

export interface RubyGemMetadata {
    name: string;
    downloads: number;
    version: string;
    version_created_at?: string;
    version_downloads: number;
    platform: string;
    authors: string;
    info: string;
    licenses?: string[] | null;
    metadata?: Record<string, string | null>;
    yanked?: boolean;
    sha?: string | null;
    spec_sha?: string | null;
    project_uri?: string | null;
    gem_uri?: string | null;
    homepage_uri?: string | null;
    wiki_uri?: string | null;
    documentation_uri?: string | null;
    mailing_list_uri?: string | null;
    source_code_uri?: string | null;
    bug_tracker_uri?: string | null;
    changelog_uri?: string | null;
    funding_uri?: string | null;
    dependencies?: RubyGemDependencies;
}

export interface RubyGemVersion {
    authors: string;
    built_at?: string;
    created_at: string;
    description?: string;
    downloads_count: number;
    metadata?: Record<string, string | null>;
    number: string;
    summary?: string;
    platform: string;
    rubygems_version?: string;
    ruby_version?: string;
    prerelease: boolean;
    licenses?: string[] | null;
    requirements?: string[];
    sha?: string | null;
    spec_sha?: string | null;
}

export interface XRegistryEntity {
    xid: string;
    self: string;
    epoch: number;
    createdat: string;
    modifiedat: string;
    name?: string;
    [key: string]: unknown;
}

export interface XRegistryVersion extends XRegistryEntity {
    versionid: string;
    number: string;
    platform: string;
    prerelease: boolean;
    created_at: string;
    downloads_count: number;
    gem_uri: string;
    sha: string;
    dependencies: RubyGemDependencies;
    yanked: boolean;
}

export interface XRegistryPackage extends XRegistryEntity {
    packageid: string;
    info: string;
    version: string;
    authors: string;
    licenses: string[];
    homepage_uri?: string;
    source_code_uri?: string;
    changelog_uri?: string;
    documentation_uri?: string;
    bug_tracker_uri?: string;
    gem_uri?: string;
    project_uri?: string;
    downloads: number;
    version_downloads: number;
    platform: string;
    sha: string;
    dependencies: RubyGemDependencies;
    versionsurl: string;
    versionscount?: number;
    versions?: Record<string, XRegistryVersion>;
}

export interface XRegistryError {
    type: string;
    title: string;
    status: number;
    instance: string;
    detail?: string;
    [key: string]: unknown;
}
