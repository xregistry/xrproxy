import { createRegistryCapabilities } from "@xregistry/registry-core";
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

/** xRegistry 1.0-rc2 runtime features implemented by this proxy. */
export const CAPABILITIES = createRegistryCapabilities({
    flags: ["filter"],
    versionmodes: ["manual", "createdat"],
});

export const GROUP_CONFIG = {
    TYPE: 'rubyregistries',
    TYPE_SINGULAR: 'rubyregistry',
    ID: 'rubygems',
    SOURCE_URL: 'https://rubygems.org',
} as const;

export const RESOURCE_CONFIG = {
    TYPE: 'packages',
    TYPE_SINGULAR: 'package',
} as const;

export const PAGINATION = {
    DEFAULT_LIMIT: 50,
    MAX_LIMIT: 1000,
} as const;

export const CACHE_CONFIG = {
    CACHE_TTL_MS: 60 * 60 * 1000,
    SEARCH_TTL_MS: 5 * 60 * 1000,
    HTTP_TIMEOUT_MS: 10000,
    MAX_RETRIES: 1,
    CACHE_DIR: './cache',
    SEARCH_PER_PAGE: 30,
} as const;

export const RUBYGEMS_API = {
    BASE_URL: 'https://rubygems.org/api/v1',
    PUBLIC_URL: 'https://rubygems.org',
    USER_AGENT: 'xRegistry-RubyGems-Wrapper/1.0',
} as const;

/**
 * The RubyGems "compact index" names snapshot: a plain-text, one-name-per-line
 * catalogue of every gem name ever published (see
 * https://guides.rubygems.org/rubygems-org-compact-index-api/). It is the
 * full-catalogue source of truth for package collection listings so that
 * paging/filtering no longer depends on crawling the upstream search API.
 */
export const NAMES_INDEX = {
    URL: 'https://index.rubygems.org/names',
    /** How often we re-check upstream for a fresher snapshot (conditional GET keeps this cheap). */
    REFRESH_TTL_MS: 5 * 60 * 1000,
    /** How long a previously-fetched snapshot may keep being served if upstream is unreachable. */
    STALE_IF_ERROR_MS: 7 * 24 * 60 * 60 * 1000,
    /** In-process memo so concurrent/rapid requests don't repeatedly re-read and re-clone the cached snapshot. */
    MEMO_TTL_MS: 5 * 60 * 1000,
} as const;

export const SERVER_CONFIG = {
    DEFAULT_PORT: 4000,
    DEFAULT_HOST: '0.0.0.0',
} as const;