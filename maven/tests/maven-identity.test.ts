import {
    buildHashedEntityId,
    buildNamespaceIdMap,
    buildPackageIdMap,
    toVersionId,
} from '../src/utils/maven-identity';

describe('Maven identity mapping', () => {
    it('keeps verbatim namespace ids when they are collision-free', () => {
        const map = buildNamespaceIdMap(['org.apache.commons']);
        expect(map.get('org.apache.commons')).toBe('org.apache.commons');
    });

    it('hashes case-colliding package ids except for the lexicographic winner', () => {
        const map = buildPackageIdMap(['Alpha', 'alpha', 'bravo']);
        expect(map.get('alpha')).toBe('alpha');
        expect(map.get('Alpha')).toBe(buildHashedEntityId('Alpha'));
        expect(map.get('bravo')).toBe('bravo');
    });

    it('hashes non-xRegistry-safe version ids', () => {
        expect(toVersionId('1.0.0')).toBe('1.0.0');
        expect(toVersionId('1.0.0+build')).toBe(buildHashedEntityId('1.0.0+build'));
    });
});
