import { createHash } from 'node:crypto';

import {
    identityToModulePath,
    modulePathToIdentity,
    versionIdToVersion,
    versionToId,
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

    it('reconstructs canonical module paths reversibly when the moduleid is not hashed', () => {
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

    it('hashes overlong module IDs with the reserved xh~ prefix', () => {
        const longModulePath = `example.com/${'segment/'.repeat(20)}leaf`;
        const expectedHash = createHash('sha256').update(longModulePath, 'utf8').digest('hex');
        expect(modulePathToIdentity(longModulePath)).toEqual({
            groupId: 'example.com',
            moduleId: `xh~${expectedHash}`,
        });
    });

    it('hashes later case-colliding module paths deterministically', () => {
        const collidingPaths = [
            'github.com/Case/Module',
            'github.com/case/module',
        ];
        expect(modulePathToIdentity(collidingPaths[0], { collidingModulePaths: collidingPaths })).toEqual({
            groupId: 'github.com',
            moduleId: 'Case:Module',
        });
        expect(modulePathToIdentity(collidingPaths[1], { collidingModulePaths: collidingPaths }).moduleId).toBe(
            `xh~${createHash('sha256').update(collidingPaths[1], 'utf8').digest('hex')}`
        );
    });

    it('transliterates build metadata in version identities with ~', () => {
        expect(versionToId('v2.0.0+incompatible')).toBe('v2.0.0~incompatible');
        expect(versionIdToVersion('v2.0.0~incompatible')).toBe('v2.0.0+incompatible');
    });

    it('rejects slash-bearing, hashed, and non-canonical reversible identities', () => {
        expect(() => identityToModulePath('github.com/pkg', 'errors')).toThrow();
        expect(() => identityToModulePath('github.com', 'pkg/errors')).toThrow();
        expect(() => identityToModulePath('github.com', 'pkg::errors')).toThrow();
        expect(() => identityToModulePath('github.com', 'xh~abc')).toThrow();
    });
});
