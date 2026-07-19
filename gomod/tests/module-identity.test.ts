import {
    identityToModulePath,
    modulePathToIdentity,
} from '../src/utils/path-escaping';

describe('Go module xRegistry identity', () => {
    it('maps the native domain/path hierarchy to group and resource IDs', () => {
        expect(modulePathToIdentity('github.com/pkg/errors')).toEqual({
            groupId: 'github.com',
            moduleId: 'pkg:errors',
        });
        expect(modulePathToIdentity('4d63.com/biblepassageapi')).toEqual({
            groupId: '4d63.com',
            moduleId: 'biblepassageapi',
        });
    });

    it('reconstructs canonical module paths reversibly', () => {
        expect(identityToModulePath('github.com', 'golang:protobuf:proto')).toBe(
            'github.com/golang/protobuf/proto'
        );
    });

    it('represents a domain-root module with the reserved @ resource ID', () => {
        expect(modulePathToIdentity('example.com')).toEqual({
            groupId: 'example.com',
            moduleId: '@',
        });
        expect(identityToModulePath('example.com', '@')).toBe('example.com');
    });

    it('rejects slash-bearing and non-canonical route identities', () => {
        expect(() => identityToModulePath('github.com/pkg', 'errors')).toThrow();
        expect(() => identityToModulePath('github.com', 'pkg/errors')).toThrow();
        expect(() => identityToModulePath('github.com', 'pkg::errors')).toThrow();
    });
});
