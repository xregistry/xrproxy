/**
 * Terraform Registry type definitions
 */

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export interface TFTerraformDiscovery {
    'providers.v1'?: string;
    'modules.v1'?: string;
}

// ---------------------------------------------------------------------------
// Provider types
// ---------------------------------------------------------------------------

/** Entry in the providers search / catalogue cache */
export interface ProviderEntry {
    namespace: string;
    type: string;
    id: string; // provider type; namespace is the xRegistry group ID
}

/** Raw response from GET /v1/providers/{ns}/{type}/versions */
export interface TFProviderVersionsResponse {
    id: string; // e.g. "hashicorp/aws"
    versions: TFProviderVersionSummary[];
}

export interface TFProviderVersionSummary {
    version: string;
    protocols: string[];
    platforms: TFProviderPlatformSummary[];
}

export interface TFProviderPlatformSummary {
    os: string;
    arch: string;
}

/** Raw response from GET /v1/providers/{ns}/{type}/{version}/download/{os}/{arch} */
export interface TFProviderDownloadResponse {
    protocols: string[];
    os: string;
    arch: string;
    filename: string;
    download_url: string;
    shasums_url: string;
    shasums_signature_url: string;
    shasum: string;
    signing_keys: TFSigningKeys;
}

export interface TFSigningKeys {
    gpg_public_keys: TFGPGKey[];
}

export interface TFGPGKey {
    key_id: string;
    ascii_armor?: string;
    trust_signature?: string;
    source?: string;
    source_url?: string;
}

/** Enriched per-platform distribution info (stored in version resource attributes) */
export interface ProviderPlatformDistribution {
    os: string;
    arch: string;
    protocols?: string[];
    filename?: string;
    download_url?: string;
    shasums_url?: string;
    shasums_signature_url?: string;
    shasum?: string;
    signing_keys?: TFSigningKeys;
}

// ---------------------------------------------------------------------------
// Module types
// ---------------------------------------------------------------------------

/** Entry in the modules search / catalogue cache */
export interface ModuleEntry {
    namespace: string;
    name: string;
    provider: string;
    id: string; // encoded as name~provider or xh~hash within the namespace group
}

/** Raw response from GET /v1/modules/{ns}/{name}/{provider}/versions */
export interface TFModuleVersionsResponse {
    modules: TFModuleVersionList[];
}

export interface TFModuleVersionList {
    source: string;
    versions: TFModuleVersionSummary[];
}

export interface TFModuleVersionSummary {
    version: string;
}

export interface TFModuleInput {
    name: string;
    type?: string;
    description?: string;
    default?: string;
    required?: boolean;
}

export interface TFModuleOutput {
    name: string;
    description?: string;
}

export interface TFModuleDependency {
    name: string;
    source?: string;
    version?: string;
}

export interface TFModuleProviderDependency {
    name: string;
    namespace?: string;
    source?: string;
    version?: string;
}

export interface TFModuleDeclaredResource {
    name: string;
    type?: string;
}

export interface TFModuleInterface {
    path?: string;
    name?: string;
    readme?: string;
    empty?: boolean;
    inputs?: TFModuleInput[];
    outputs?: TFModuleOutput[];
    dependencies?: TFModuleDependency[];
    provider_dependencies?: TFModuleProviderDependency[];
    resources?: TFModuleDeclaredResource[];
}

/** Raw response from GET /v1/modules/{ns}/{name}/{provider}/{version} */
export interface TFModuleVersionDetail {
    id: string;
    owner?: string;
    namespace: string;
    name: string;
    version?: string;
    provider: string;
    provider_logo_url?: string;
    description?: string;
    source?: string;
    published_at?: string;
    downloads?: number;
    verified?: boolean;
    trusted?: boolean;
    providers?: string[];
    versions?: string[];
    root?: TFModuleInterface;
    submodules?: TFModuleInterface[];
}

// ---------------------------------------------------------------------------
// v2 JSON:API provider search types
// ---------------------------------------------------------------------------

export interface TFV2ProvidersResponse {
    data: TFV2ProviderData[];
    links?: {
        first?: string;
        prev?: string;
        next?: string;
        last?: string;
    };
    meta?: {
        pagination?: {
            page: number;
            'page-size': number;
            'total-pages': number;
            'total-count': number;
        };
    };
}

export interface TFV2ProviderData {
    id: string;
    type: string;
    attributes: TFV2ProviderAttributes;
}

export interface TFV2ProviderAttributes {
    namespace: string;
    name: string;
    'full-name': string;
    description: string;
    downloads: number;
    tier: string;
    logo_url?: string;
    categories?: string[];
    featured?: boolean;
    unlisted?: boolean;
    warning?: string;
    aliases?: string[];
}

// ---------------------------------------------------------------------------
// v1 module search types
// ---------------------------------------------------------------------------

export interface TFV1ModuleSearchResponse {
    modules: TFV1ModuleSearchItem[];
    meta: {
        limit: number;
        current_offset: number;
        next_offset?: number;
        next_url?: string;
    };
}

export interface TFV1ModuleSearchItem {
    id: string;
    namespace: string;
    name: string;
    provider: string;
    source: string;
    versions: string[];
    downloads: number;
    verified: boolean;
    trusted?: boolean;
    owner?: string;
    description?: string;
}

// ---------------------------------------------------------------------------
// Cache entry
// ---------------------------------------------------------------------------

export interface CacheEntry<T = unknown> {
    etag: string | null;
    data: T;
    timestamp: number;
}
