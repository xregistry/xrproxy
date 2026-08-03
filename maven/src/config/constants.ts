/**
 * Configuration Constants
 * @fileoverview Configuration constants for Maven xRegistry server
 */

import { Request } from 'express';
import * as path from 'path';

/**
 * Get the actual base URL from the request.
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

export const XREGISTRY_CONFIG = {
    REGISTRY_ID: 'maven-wrapper',
    SPEC_VERSION: '1.0-rc2',
    SCHEMA_VERSION: 'xRegistry-json/1.0-rc2',
    DEFAULT_PAGE_LIMIT: 50,
    MAX_PAGE_LIMIT: 1000
} as const;

export const GROUP_CONFIG = {
    TYPE: 'javanamespaces',
    TYPE_SINGULAR: 'javanamespace'
} as const;

export const RESOURCE_CONFIG = {
    TYPE: 'packages',
    TYPE_SINGULAR: 'package'
} as const;

export const MAVEN_REGISTRY = {
    API_BASE_URL: 'https://search.maven.org/solrsearch/select',
    REPO_URL: 'https://repo.maven.apache.org/maven2',
    TIMEOUT_MS: 30000,
    USER_AGENT: 'xRegistry-Maven-Wrapper/1.0'
} as const;

export const MAX_SOLR_ROWS = 200;

export const CACHE_CONFIG = {
    CACHE_DIR: path.join(process.cwd(), 'cache'),
    CACHE_TTL_MS: 3600000,
    MAX_CACHE_SIZE: 1000,
    SEARCH_CACHE_SIZE: 800,
    SEARCH_CACHE_TTL: 600000,
    MAX_METADATA_FETCHES: 30
} as const;

export const PAGINATION = {
    DEFAULT_PAGE_LIMIT: 50,
    MAX_PAGE_LIMIT: 1000,
    DEFAULT_OFFSET: 0
} as const;

export const HTTP_STATUS = {
    OK: 200,
    CREATED: 201,
    NO_CONTENT: 204,
    BAD_REQUEST: 400,
    UNAUTHORIZED: 401,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    CONFLICT: 409,
    INTERNAL_SERVER_ERROR: 500,
    SERVICE_UNAVAILABLE: 503
} as const;

export const SERVER_CONFIG = {
    PORT: parseInt(process.env['XREGISTRY_MAVEN_PORT'] || process.env['PORT'] || '3300'),
    HOST: process.env['XREGISTRY_MAVEN_HOST'] || '0.0.0.0',
    BASE_URL: process.env['XREGISTRY_MAVEN_BASEURL'] || null,
    API_KEY: process.env['XREGISTRY_MAVEN_API_KEY'] || null,
    LOG_FILE: process.env['XREGISTRY_MAVEN_LOG'] || null,
    LOG_LEVEL: process.env['LOG_LEVEL'] || 'info',
    QUIET_MODE: process.env['XREGISTRY_MAVEN_QUIET'] == 'true',
    W3C_LOG_FILE: process.env['W3C_LOG_FILE'],
    W3C_LOG_STDOUT: process.env['W3C_LOG_STDOUT'] == 'true',
    SERVICE_NAME: process.env['SERVICE_NAME'] || 'xregistry-maven',
    SERVICE_VERSION: process.env['SERVICE_VERSION'] || '1.0.0',
    ENVIRONMENT: process.env['NODE_ENV'] || 'production'
} as const;
