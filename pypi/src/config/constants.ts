/**
 * Configuration constants for PyPI xRegistry server
 */

import { Request } from 'express';
import * as modelData from '../../model.json';

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

export const SERVER_CONFIG = {
    DEFAULT_PORT: 3000,
    DEFAULT_PAGE_LIMIT: 50,
    REFRESH_INTERVAL: 6 * 60 * 60 * 1000,
} as const;

export const REGISTRY_METADATA = {
    REGISTRY_ID: 'pypi-wrapper',
    GROUP_TYPE: 'pythonregistries',
    GROUP_TYPE_SINGULAR: 'pythonregistry',
    GROUP_ID: 'pypi',
    RESOURCE_TYPE: 'packages',
    RESOURCE_TYPE_SINGULAR: 'package',
    SPEC_VERSION: '1.0-rc2',
    SCHEMA_VERSION: 'xRegistry-json/1.0-rc2',
} as const;

export const PYPI_API = {
    SIMPLE_URL: 'https://pypi.org/simple/',
    JSON_API_URL: 'https://pypi.org/pypi',
    SIMPLE_ACCEPT_HEADER: 'application/vnd.pypi.simple.v1+json',
} as const;

export const FILTER_CONFIG = {
    CACHE_SIZE: 1500,
    MAX_CACHE_AGE: 600000,
    ENABLE_TWO_STEP_FILTERING: true,
    MAX_METADATA_FETCHES: 50,
} as const;

export const FALLBACK_PACKAGES = [
    'beautifulsoup4',
    'certifi',
    'charset-normalizer',
    'click',
    'django',
    'flask',
    'idna',
    'jinja2',
    'numpy',
    'pandas',
    'pillow',
    'pip',
    'pygame',
    'pytest',
    'python-dateutil',
    'pytz',
    'requests',
    'scipy',
    'setuptools',
    'six',
    'tornado',
    'urllib3',
    'wheel',
    'pyyaml',
] as const;

export const CACHE_CONFIG = {
    CACHE_DIR_NAME: 'cache',
    USE_ETAG: true,
} as const;

export const ERROR_TYPES = {
    BASE_URL: 'https://github.com/xregistry/spec/blob/main/core/spec.md',
    TYPES: {
        NOT_FOUND: 'not-found',
        INVALID_INPUT: 'invalid-input',
        UNAUTHORIZED: 'unauthorized',
        INTERNAL_ERROR: 'internal-error',
        INVALID_FILTER: 'invalid-filter',
    },
} as const;

export const HTTP_STATUS = {
    OK: 200,
    NOT_MODIFIED: 304,
    BAD_REQUEST: 400,
    UNAUTHORIZED: 401,
    NOT_FOUND: 404,
    INTERNAL_SERVER_ERROR: 500,
} as const;

export const XREGISTRY_PARAMS = {
    INLINE: 'inline',
    FILTER: 'filter',
    SORT: 'sort',
    LIMIT: 'limit',
    OFFSET: 'offset',
    EXPORT: 'export',
} as const;

export const MODEL_STRUCTURE = modelData;
