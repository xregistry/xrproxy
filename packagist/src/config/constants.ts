/**
 * Application constants for the Packagist xRegistry wrapper
 */

import { createRegistryCapabilities } from "@xregistry/registry-core";
import { Request } from 'express';

/**
 * Determine the base URL from the incoming request.
 * Priority:
 *  1. x-base-url header (set by bridge)
 *  2. BASE_URL env variable
 *  3. x-forwarded-* headers
 *  4. Constructed from req.protocol / req.host
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

export const REGISTRY_CONFIG = {
    ID: 'packagist-wrapper',
    SPEC_VERSION: '1.0-rc2',
} as const;

/** xRegistry 1.0-rc2 runtime features implemented by this proxy. */
export const CAPABILITIES = createRegistryCapabilities({
    flags: ["filter", "sort"],
    versionmodes: ["manual", "createdat"],
});

export const GROUP_CONFIG = {
    TYPE: 'composerregistries',
    TYPE_SINGULAR: 'composerregistry',
    /** Pre-#203 fixed group, reserved for explicit migration responses. */
    LEGACY_ID: 'packagist.org',
} as const;

export const RESOURCE_CONFIG = {
    TYPE: 'packages',
    TYPE_SINGULAR: 'package',
} as const;

export const PAGINATION = {
    DEFAULT_PAGE_LIMIT: 50,
    MAX_PAGE_LIMIT: 1000,
} as const;

export const CACHE_CONFIG = {
    REFRESH_INTERVAL_MS: 24 * 60 * 60 * 1000,   // 24 h
    HTTP_TIMEOUT_MS: 30000,                        // 30 s
    MAX_RETRIES: 3,
    CACHE_TTL_MS: 6 * 60 * 60 * 1000,            // 6 h (shorter; Packagist updates frequently)
    FILTER_CACHE_SIZE: 2000,
    FILTER_CACHE_TTL_MS: 600000,
    MAX_METADATA_FETCHES: 20,
    MAX_CACHE_SIZE: 5000,
    CACHE_DIR: './cache',
} as const;

export const SERVER_CONFIG = {
    DEFAULT_PORT: 4100,
    DEFAULT_HOST: '0.0.0.0',
} as const;

export const HTTP_STATUS = {
    OK: 200,
    NOT_MODIFIED: 304,
    BAD_REQUEST: 400,
    UNAUTHORIZED: 401,
    NOT_FOUND: 404,
    NOT_ACCEPTABLE: 406,
    INTERNAL_SERVER_ERROR: 500,
    BAD_GATEWAY: 502,
    GATEWAY_TIMEOUT: 504,
} as const;

export const PACKAGIST_CONFIG = {
    BASE_URL: 'https://packagist.org',
    API_V2_BASE: 'https://packagist.org/p2',
    USER_AGENT: 'xRegistry-Packagist-Wrapper/1.0 (https://github.com/xregistry/xrproxy)',
} as const;
