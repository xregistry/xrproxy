/**
 * Application constants for the NuGet xRegistry wrapper
 */

import { Request } from 'express';

/**
 * Get the actual base URL from the request.
 */
export function getBaseUrl(req: Request): string {
    const baseUrlHeader = req.get('x-base-url');
    if (baseUrlHeader) {
        return baseUrlHeader.replace(/\/+$/, '');
    }

    if (process.env['BASE_URL']) {
        return process.env['BASE_URL'].replace(/\/+$/, '');
    }

    const protocol = req.get('x-forwarded-proto') || req.protocol || 'https';
    const host = req.get('x-forwarded-host') || req.get('host');
    if (host) {
        return `${protocol}://${host}`.replace(/\/+$/, '');
    }

    return `${req.protocol}://${req.get('host')}`.replace(/\/+$/, '');
}

export const REGISTRY_CONFIG = {
    ID: 'nuget-wrapper',
    SPEC_VERSION: '1.0-rc2',
    SCHEMA_VERSION: 'xRegistry-json/1.0-rc2',
} as const;

export const GROUP_CONFIG = {
    TYPE: 'dotnetregistries',
    TYPE_SINGULAR: 'dotnetregistry',
    ID: 'nuget',
    SOURCE_URL: 'https://api.nuget.org/v3/index.json',
} as const;

export const RESOURCE_CONFIG = {
    TYPE: 'packages',
    TYPE_SINGULAR: 'package',
} as const;

export const PAGINATION = {
    DEFAULT_PAGE_LIMIT: 20,
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
    DEFAULT_PORT: 3300,
    DEFAULT_HOST: '0.0.0.0',
} as const;

export const HTTP_STATUS = {
    OK: 200,
    NOT_MODIFIED: 304,
    BAD_REQUEST: 400,
    UNAUTHORIZED: 401,
    NOT_FOUND: 404,
    METHOD_NOT_ALLOWED: 405,
    NOT_ACCEPTABLE: 406,
    INTERNAL_SERVER_ERROR: 500,
    BAD_GATEWAY: 502,
    GATEWAY_TIMEOUT: 504,
} as const;

export const NUGET_REGISTRY = {
    BASE_URL: 'https://api.nuget.org',
    SERVICE_INDEX_URL: 'https://api.nuget.org/v3/index.json',
    SEARCH_URL: 'https://azuresearch-usnc.nuget.org/query',
    REGISTRATION_BASE_URL: 'https://api.nuget.org/v3/registration5-semver1',
    CATALOG_INDEX_URL: 'https://api.nuget.org/v3/catalog0/index.json',
    FLAT_CONTAINER_URL: 'https://api.nuget.org/v3-flatcontainer',
    USER_AGENT: 'xRegistry-NuGet-Wrapper/1.0',
    TIMEOUT_MS: 10000,
} as const;

export const PATHS = {
    CACHE_DIR: 'cache',
    CACHE_FILE: 'package-names-cache.json',
    CACHE_METADATA_FILE: 'cache-metadata.json',
} as const;
