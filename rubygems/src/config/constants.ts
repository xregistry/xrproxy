import { Request } from 'express';

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
    ID: 'rubygems-wrapper',
    SPEC_VERSION: '1.0-rc2',
} as const;

export const GROUP_CONFIG = {
    TYPE: 'rubyregistries',
    TYPE_SINGULAR: 'rubyregistry',
    ID: 'rubygems.org',
} as const;

export const RESOURCE_CONFIG = {
    TYPE: 'packages',
    TYPE_SINGULAR: 'package',
} as const;

export const PAGINATION = {
    DEFAULT_LIMIT: 50,
    MAX_LIMIT: 100,
} as const;

export const CACHE_CONFIG = {
    CACHE_TTL_MS: 60 * 60 * 1000,
    SEARCH_TTL_MS: 5 * 60 * 1000,
    HTTP_TIMEOUT_MS: 10000,
    MAX_RETRIES: 1,
    CACHE_DIR: './cache',
    MAX_SEARCH_PAGES: 5,
    SEARCH_PER_PAGE: 30,
} as const;

export const RUBYGEMS_API = {
    BASE_URL: 'https://rubygems.org/api/v1',
    USER_AGENT: 'xRegistry-RubyGems-Wrapper/1.0',
} as const;

export const SERVER_CONFIG = {
    DEFAULT_PORT: 4000,
    DEFAULT_HOST: '0.0.0.0',
} as const;
