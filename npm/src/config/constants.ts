/**
 * Application constants for the NPM xRegistry wrapper
 */

import { Request } from 'express';

/**
 * Get the actual base URL from the request
 * This handles cases where the deployed FQDN differs from req.protocol/req.host
 * Priority order:
 * 1. x-base-url header (set by bridge when proxying - contains actual external FQDN)
 * 2. x-forwarded-* headers (set by reverse proxies like Azure Container Apps)
 * 3. Construct from request properties (fallback for development)
 */
export function getBaseUrl(req: Request): string {
    const baseUrlHeader = req.get('x-base-url');
    if (baseUrlHeader) {
        return baseUrlHeader;
    }

    if (process.env['BASE_URL']) {
        return process.env['BASE_URL'];
    }

    const protocol = req.get('x-forwarded-proto') || req.protocol || 'https';
    const host = req.get('x-forwarded-host') || req.get('host');

    if (host) {
        return `${protocol}://${host}`;
    }

    return `${req.protocol}://${req.get('host')}`;
}

export const REGISTRY_CONFIG = {
    ID: 'npm-wrapper',
    SPEC_VERSION: '1.0-rc2',
    SCHEMA_VERSION: 'xRegistry-json/1.0-rc2',
} as const;

export const GROUP_CONFIG = {
    TYPE: 'nodescopes',
    TYPE_SINGULAR: 'nodescope',
    UNSCOPED_ID: '_',
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
    REFRESH_INTERVAL_MS: 24 * 60 * 60 * 1000,
    HTTP_TIMEOUT_MS: 30000,
    MAX_RETRIES: 3,
    CACHE_TTL_MS: 24 * 60 * 60 * 1000,
    FILTER_CACHE_SIZE: 2000,
    FILTER_CACHE_TTL_MS: 600000,
    MAX_METADATA_FETCHES: 20,
    MAX_CACHE_SIZE: 10000,
    CACHE_DIR: './cache',
} as const;

export const SERVER_CONFIG = {
    DEFAULT_PORT: 3100,
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

export const NPM_REGISTRY = {
    BASE_URL: 'https://registry.npmjs.org',
    USER_AGENT: 'xRegistry-NPM-Wrapper/1.0',
} as const;

export const PATHS = {
    CACHE_DIR: 'cache',
    CACHE_FILE: 'package-names-cache.json',
    CACHE_METADATA_FILE: 'cache-metadata.json',
} as const;
