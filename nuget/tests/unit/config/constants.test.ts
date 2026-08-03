import { CACHE_CONFIG, GROUP_CONFIG, HTTP_STATUS, NUGET_REGISTRY, PAGINATION, PATHS, REGISTRY_CONFIG, RESOURCE_CONFIG } from '../../../src/config/constants';

describe('Application Constants', () => {
    test('uses the canonical dotnet group identifier', () => {
        expect(GROUP_CONFIG.TYPE).toBe('dotnetregistries');
        expect(GROUP_CONFIG.TYPE_SINGULAR).toBe('dotnetregistry');
        expect(GROUP_CONFIG.ID).toBe('nuget');
        expect(GROUP_CONFIG.SOURCE_URL).toBe('https://api.nuget.org/v3/index.json');
    });

    test('uses the canonical package collection identifiers', () => {
        expect(RESOURCE_CONFIG.TYPE).toBe('packages');
        expect(RESOURCE_CONFIG.TYPE_SINGULAR).toBe('package');
    });

    test('keeps registry metadata on the current xRegistry version', () => {
        expect(REGISTRY_CONFIG.ID).toBe('nuget-wrapper');
        expect(REGISTRY_CONFIG.SPEC_VERSION).toBe('1.0-rc2');
        expect(REGISTRY_CONFIG.SCHEMA_VERSION).toBe('xRegistry-json/1.0-rc2');
    });

    test('exports the NuGet upstream endpoints used by the projection', () => {
        expect(NUGET_REGISTRY.BASE_URL).toBe('https://api.nuget.org');
        expect(NUGET_REGISTRY.SERVICE_INDEX_URL).toBe('https://api.nuget.org/v3/index.json');
        expect(NUGET_REGISTRY.SEARCH_URL).toBe('https://azuresearch-usnc.nuget.org/query');
        expect(NUGET_REGISTRY.REGISTRATION_BASE_URL).toBe('https://api.nuget.org/v3/registration5-semver1');
        expect(NUGET_REGISTRY.FLAT_CONTAINER_URL).toBe('https://api.nuget.org/v3-flatcontainer');
    });

    test('keeps pagination and cache defaults sane', () => {
        expect(PAGINATION.DEFAULT_PAGE_LIMIT).toBe(20);
        expect(PAGINATION.MAX_PAGE_LIMIT).toBe(1000);
        expect(CACHE_CONFIG.CACHE_TTL_MS).toBeGreaterThan(0);
        expect(CACHE_CONFIG.HTTP_TIMEOUT_MS).toBeGreaterThan(0);
    });

    test('includes 405 for read-only method handling', () => {
        expect(HTTP_STATUS.METHOD_NOT_ALLOWED).toBe(405);
    });

    test('keeps cache path names stable', () => {
        expect(PATHS.CACHE_DIR).toBe('cache');
        expect(PATHS.CACHE_FILE).toBe('package-names-cache.json');
        expect(PATHS.CACHE_METADATA_FILE).toBe('cache-metadata.json');
    });
});
