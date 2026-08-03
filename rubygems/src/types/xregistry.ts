export interface RubyGemDependency {
    name: string;
    requirements: string;
}

export interface RubyGemDependencies {
    development?: RubyGemDependency[];
    runtime?: RubyGemDependency[];
}

export interface RubyGemAttestation {
    media_type: string;
    bundle: Record<string, unknown>;
}

export interface RubyGemMetadata {
    name: string;
    downloads?: number;
    version: string;
    version_created_at?: string;
    version_downloads?: number;
    platform?: string;
    authors?: string;
    info?: string;
    description?: string;
    full_name?: string | null;
    licenses?: string[] | null;
    metadata?: Record<string, string | null> | null;
    yanked?: boolean;
    prerelease?: boolean;
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
    ruby_version?: string | null;
    rubygems_version?: string | null;
    requirements?: string[] | null;
    built_at?: string | null;
    dependencies?: RubyGemDependencies;
    attestations?: RubyGemAttestation[] | null;
}

export interface RubyGemVersion {
    authors?: string;
    built_at?: string;
    created_at: string;
    description?: string;
    downloads_count?: number;
    metadata?: Record<string, string | null> | null;
    number: string;
    summary?: string;
    platform: string;
    rubygems_version?: string | null;
    ruby_version?: string | null;
    prerelease?: boolean;
    licenses?: string[] | null;
    requirements?: string[] | null;
    sha?: string | null;
    spec_sha?: string | null;
    full_name?: string | null;
    yanked?: boolean;
    dependencies?: RubyGemDependencies;
    attestations?: RubyGemAttestation[] | null;
}

export interface RubyGemOwner {
    handle: string;
    role?: string;
}

export interface RubyGemUpstreamOwner {
    handle?: string;
    owner?: string;
    name?: string;
    email?: string;
    role?: string;
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
    packageid: string;
    isdefault: boolean;
    ancestor: string;
}

export interface XRegistryPackage extends XRegistryVersion {
    metaurl: string;
    versionsurl: string;
    versionscount: number;
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
