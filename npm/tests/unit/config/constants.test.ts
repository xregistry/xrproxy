/**
 * Unit tests for application constants.
 */

import {
    CACHE_CONFIG,
    GROUP_CONFIG,
    HTTP_STATUS,
    NPM_REGISTRY,
    PAGINATION,
    PATHS,
    REGISTRY_CONFIG,
    RESOURCE_CONFIG,
} from '../../../src/config/constants';

describe('Application Constants', () => {
    test('uses the expected registry configuration', () => {
        expect(REGISTRY_CONFIG.ID).toBe('npm-wrapper');
        expect(REGISTRY_CONFIG.SPEC_VERSION).toBe('1.0-rc2');
        expect(REGISTRY_CONFIG.SCHEMA_VERSION).toBe('xRegistry-json/1.0-rc2');
    });

    test('uses nodescope groups per npm spec', () => {
        expect(GROUP_CONFIG.TYPE).toBe('nodescopes');
        expect(GROUP_CONFIG.TYPE_SINGULAR).toBe('nodescope');
        expect(GROUP_CONFIG.UNSCOPED_ID).toBe('_');
    });

    test('uses package resources', () => {
        expect(RESOURCE_CONFIG.TYPE).toBe('packages');
        expect(RESOURCE_CONFIG.TYPE_SINGULAR).toBe('package');
    });

    test('keeps pagination, cache, and registry defaults', () => {
        expect(PAGINATION.DEFAULT_PAGE_LIMIT).toBe(50);
        expect(PAGINATION.MAX_PAGE_LIMIT).toBe(1000);
        expect(CACHE_CONFIG.HTTP_TIMEOUT_MS).toBe(30000);
        expect(NPM_REGISTRY.BASE_URL).toBe('https://registry.npmjs.org');
        expect(PATHS.CACHE_FILE).toBe('package-names-cache.json');
    });

    test('keeps standard HTTP status codes', () => {
        expect(HTTP_STATUS.OK).toBe(200);
        expect(HTTP_STATUS.NOT_FOUND).toBe(404);
        expect(HTTP_STATUS.INTERNAL_SERVER_ERROR).toBe(500);
    });
});
