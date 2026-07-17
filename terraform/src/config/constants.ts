/**
 * Configuration constants for Terraform Registry xRegistry server
 */

import { Request } from 'express';
import * as modelData from '../../model.json';

/**
 * Get the actual base URL from the request.
 * Priority: x-base-url header → BASE_URL env → x-forwarded-* → req properties
 */
export function getBaseUrl(req: Request): string {
    const baseUrlHeader = req.get('x-base-url');
    if (baseUrlHeader) return baseUrlHeader;

    if (process.env['BASE_URL']) return process.env['BASE_URL'];

    const protocol = req.get('x-forwarded-proto') || req.protocol || 'https';
    const host = req.get('x-forwarded-host') || req.get('host');
    if (host) return `${protocol}://${host}`;

    return `${req.protocol}://${req.get('host')}`;
}

/**
 * Server configuration
 */
export const SERVER_CONFIG = {
    DEFAULT_PORT: 3800,
    DEFAULT_PAGE_LIMIT: 25,
    /** Terraform Registry is relatively stable; refresh every 6 h */
    REFRESH_INTERVAL: 6 * 60 * 60 * 1000,
} as const;

/**
 * xRegistry metadata constants
 */
export const REGISTRY_METADATA = {
    REGISTRY_ID: 'terraform-registry-wrapper',
    GROUP_TYPE: 'terraformregistries',
    GROUP_TYPE_SINGULAR: 'terraformregistry',
    GROUP_ID: 'registry.terraform.io',
    PROVIDER_RESOURCE_TYPE: 'providers',
    PROVIDER_RESOURCE_TYPE_SINGULAR: 'provider',
    MODULE_RESOURCE_TYPE: 'modules',
    MODULE_RESOURCE_TYPE_SINGULAR: 'module',
    SPEC_VERSION: '1.0-rc2',
} as const;

/**
 * Terraform Registry API endpoints
 */
export const TERRAFORM_API = {
    REGISTRY_URL: 'https://registry.terraform.io',
    /** Provider versions list */
    providerVersionsUrl: (namespace: string, type: string): string =>
        `https://registry.terraform.io/v1/providers/${namespace}/${type}/versions`,
    /** Per-platform provider download info (includes download_url, shasum, signing keys) */
    providerDownloadUrl: (
        namespace: string,
        type: string,
        version: string,
        os: string,
        arch: string
    ): string =>
        `https://registry.terraform.io/v1/providers/${namespace}/${type}/${version}/download/${os}/${arch}`,
    /** Module versions list */
    moduleVersionsUrl: (namespace: string, name: string, provider: string): string =>
        `https://registry.terraform.io/v1/modules/${namespace}/${name}/${provider}/versions`,
    /** Single module version detail */
    moduleVersionUrl: (namespace: string, name: string, provider: string, version: string): string =>
        `https://registry.terraform.io/v1/modules/${namespace}/${name}/${provider}/${version}`,
    /** Provider search (v2 JSON:API) */
    SEARCH_PROVIDERS: 'https://registry.terraform.io/v2/providers',
    /** Module search (v1) */
    SEARCH_MODULES: 'https://registry.terraform.io/v1/modules',
} as const;

/**
 * ID encoding / decoding helpers.
 *
 * Provider ID:  namespace~type         (e.g. hashicorp~aws)
 * Module ID:    namespace~name~provider (e.g. hashicorp~consul~aws)
 *
 * The tilde (~) is URL-safe, never appears in Terraform registry names,
 * and provides collision-safe segmentation within a single URL path segment.
 */
export const ID_SEP = '~';

export function encodeProviderId(namespace: string, type: string): string {
    return `${namespace}${ID_SEP}${type}`;
}

export function decodeProviderId(id: string): { namespace: string; type: string } | null {
    const parts = id.split(ID_SEP);
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    return { namespace: parts[0], type: parts[1] };
}

export function encodeModuleId(namespace: string, name: string, provider: string): string {
    return `${namespace}${ID_SEP}${name}${ID_SEP}${provider}`;
}

export function decodeModuleId(id: string): { namespace: string; name: string; provider: string } | null {
    const parts = id.split(ID_SEP);
    if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return null;
    return { namespace: parts[0], name: parts[1], provider: parts[2] };
}

/**
 * Cache configuration
 */
export const CACHE_CONFIG = {
    CACHE_DIR_NAME: 'cache',
    USE_ETAG: true,
} as const;

/**
 * HTTP status constants
 */
export const HTTP_STATUS = {
    OK: 200,
    NOT_MODIFIED: 304,
    BAD_REQUEST: 400,
    UNAUTHORIZED: 401,
    NOT_FOUND: 404,
    METHOD_NOT_ALLOWED: 405,
    INTERNAL_SERVER_ERROR: 500,
} as const;

/** Loaded model.json (for /model endpoint) */
export const MODEL_STRUCTURE = modelData;

/** Popular providers used when the registry search is unavailable */
export const FALLBACK_PROVIDERS: Array<{ namespace: string; type: string }> = [
    { namespace: 'hashicorp', type: 'aws' },
    { namespace: 'hashicorp', type: 'azurerm' },
    { namespace: 'hashicorp', type: 'google' },
    { namespace: 'hashicorp', type: 'kubernetes' },
    { namespace: 'hashicorp', type: 'helm' },
    { namespace: 'hashicorp', type: 'null' },
    { namespace: 'hashicorp', type: 'random' },
    { namespace: 'hashicorp', type: 'time' },
    { namespace: 'hashicorp', type: 'local' },
    { namespace: 'hashicorp', type: 'tls' },
];

/** Popular modules used when the registry search is unavailable */
export const FALLBACK_MODULES: Array<{ namespace: string; name: string; provider: string }> = [
    { namespace: 'terraform-aws-modules', name: 'vpc', provider: 'aws' },
    { namespace: 'terraform-aws-modules', name: 'eks', provider: 'aws' },
    { namespace: 'terraform-aws-modules', name: 's3-bucket', provider: 'aws' },
    { namespace: 'hashicorp', name: 'consul', provider: 'aws' },
    { namespace: 'hashicorp', name: 'vault', provider: 'aws' },
];
