import { GROUP_CONFIG, MAVEN_REGISTRY, RESOURCE_CONFIG, XREGISTRY_CONFIG } from '../src/config/constants';

describe('Maven constants', () => {
    it('uses javanamespace group naming from the spec', () => {
        expect(GROUP_CONFIG.TYPE).toBe('javanamespaces');
        expect(GROUP_CONFIG.TYPE_SINGULAR).toBe('javanamespace');
        expect('ID' in GROUP_CONFIG).toBe(false);
    });

    it('keeps the package resource type names', () => {
        expect(RESOURCE_CONFIG.TYPE).toBe('packages');
        expect(RESOURCE_CONFIG.TYPE_SINGULAR).toBe('package');
    });

    it('keeps Maven Central provenance configuration', () => {
        expect(MAVEN_REGISTRY.REPO_URL).toBe('https://repo.maven.apache.org/maven2');
        expect(MAVEN_REGISTRY.API_BASE_URL).toContain('search.maven.org');
        expect(XREGISTRY_CONFIG.REGISTRY_ID).toBe('maven-wrapper');
    });
});
