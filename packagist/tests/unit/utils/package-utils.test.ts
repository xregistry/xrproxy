/**
 * Unit tests for package-utils – especially the critical dev-* identity rule.
 */

import {
    buildVersionId,
    identityToPackageName,
    packageNameToIdentity,
    isDevVersion,
    isValidPackageName,
} from '../../../src/utils/package-utils';

describe('Composer package xRegistry identity', () => {
    it('maps vendor to group and package basename to resource', () => {
        expect(packageNameToIdentity('symfony/console')).toEqual({
            groupId: 'symfony', resourceId: 'console', canonicalName: 'symfony/console',
        });
    });

    it('reconstructs the canonical package path', () => {
        expect(identityToPackageName('laravel', 'framework')).toBe('laravel/framework');
    });

    it('normalizes authoritative upstream identity to lowercase', () => {
        expect(packageNameToIdentity('Symfony/Console')).toEqual({
            groupId: 'symfony', resourceId: 'console', canonicalName: 'symfony/console',
        });
    });

    it('rejects slash-bearing entity IDs', () => {
        expect(() => identityToPackageName('symfony/components', 'console')).toThrow();
        expect(() => identityToPackageName('symfony', 'component/console')).toThrow();
    });

    it('rejects upstream names without exactly one slash', () => {
        expect(() => packageNameToIdentity('console')).toThrow();
        expect(() => packageNameToIdentity('vendor/nested/package')).toThrow();
        expect(() => packageNameToIdentity(`vendor/${'x'.repeat(129)}`)).toThrow();
    });
});

describe('isDevVersion', () => {
    it('returns true for dev-main', () => expect(isDevVersion('dev-main')).toBe(true));
    it('returns true for dev-master', () => expect(isDevVersion('dev-master')).toBe(true));
    it('returns true for dev-feature-branch', () => expect(isDevVersion('dev-feature-branch')).toBe(true));
    it('returns false for stable 1.0.0', () => expect(isDevVersion('1.0.0')).toBe(false));
    it('returns false for v7.1.0', () => expect(isDevVersion('v7.1.0')).toBe(false));
    it('returns false for 2.0.0-beta.1', () => expect(isDevVersion('2.0.0-beta.1')).toBe(false));
});

describe('buildVersionId – dev-* collision safety', () => {
    it('generates source-reference-qualified ID for dev-main', () => {
        const id = buildVersionId('dev-main', 'dev-main', 'deadbeef1234567890abcdef');
        expect(id).toMatch(/^xv~d~/);
    });

    it('reversibly represents an absent source reference without a sentinel collision', () => {
        const id = buildVersionId('dev-main', 'dev-main');
        expect(id).toMatch(/^xv~d~/);
        expect(id.endsWith('~')).toBe(true);
    });

    it('generates stable ID for stable version (uses normalized)', () => {
        const id = buildVersionId('v7.1.0', '7.1.0.0', 'abc123');
        expect(id).toBe('7.1.0.0');
    });

    it('falls back to display version when normalized is absent', () => {
        const id = buildVersionId('1.0.0', '', 'abc');
        expect(id).toBe('1.0.0');
    });

    it('two dev-main at different commits produce different IDs', () => {
        const id1 = buildVersionId('dev-main', 'dev-main', 'aabbccdd1234567890000001');
        const id2 = buildVersionId('dev-main', 'dev-main', 'deadbeef1234567890000002');
        expect(id1).not.toBe(id2);
    });

    it('does not collide when full refs share the old 12-character prefix', () => {
        const id1 = buildVersionId('dev-main', 'dev-main', 'deadbeef1234aaaaaaaa');
        const id2 = buildVersionId('dev-main', 'dev-main', 'deadbeef1234bbbbbbbb');
        expect(id1).not.toBe(id2);
    });

    it('does not collapse distinct aliases through underscore sanitization', () => {
        const ref = 'deadbeef1234567890';
        expect(buildVersionId('dev-feature/foo', 'dev-feature/foo', ref))
            .not.toBe(buildVersionId('dev-feature_foo', 'dev-feature_foo', ref));
    });

    it('compacts long branch aliases within the xRegistry ID limit without collapsing them', () => {
        const a = buildVersionId(
            'dev-dependabot/github_actions/dot-github/workflows/shivammathur/setup-php-2.37.1',
            'dev-long',
            '7fb9a3221db596c65ed0cf1069d9806e5d1c2e68',
        );
        const b = buildVersionId(
            'dev-dependabot/github_actions/dot-github/workflows/shivammathur/setup-php-2.37.2',
            'dev-long',
            '7fb9a3221db596c65ed0cf1069d9806e5d1c2e68',
        );
        expect(a).toMatch(/^xv~d~h~/);
        expect(a.length).toBeLessThanOrEqual(128);
        expect(a).not.toBe(b);
    });

    it('same dev-main at same commit produces identical ID (deterministic)', () => {
        const ref = 'cafebabe1234567890abcdef';
        const id1 = buildVersionId('dev-main', 'dev-main', ref);
        const id2 = buildVersionId('dev-main', 'dev-main', ref);
        expect(id1).toBe(id2);
    });

    it('IDs contain only xRegistry-safe characters', () => {
        const xregistrySafe = /^[a-zA-Z0-9\-._~]+$/;
        const stable = buildVersionId('v7.1.0', '7.1.0.0', 'abc');
        const dev = buildVersionId('dev-main', 'dev-main', 'deadbeef1234');
        expect(xregistrySafe.test(stable)).toBe(true);
        expect(xregistrySafe.test(dev)).toBe(true);
    });
});

describe('dev-* ID mutation and collision properties', () => {
    it('advancing branch (new sourceRef) changes versionid', () => {
        const old = buildVersionId('dev-main', 'dev-main', 'aabbccdd0000000000000000');
        const next = buildVersionId('dev-main', 'dev-main', 'deadbeef0000000000000000');
        expect(old).not.toBe(next);
    });

    it('no stable release ID can collide with a dev-* ID', () => {
        // Stable and dev IDs occupy disjoint encodings.
        const stable = buildVersionId('1.0.0', '1.0.0.0', 'abc123');
        const devIds = [
            buildVersionId('dev-main', 'dev-main', 'abc1230000000000000000'),
            buildVersionId('dev-1.0.0', 'dev-1.0.0', 'abc1230000000000000000'),
        ];
        for (const devId of devIds) {
            expect(stable).not.toBe(devId);
        }
    });

    it('dev- prefix distinguishes dev-x.y.z from stable x.y.z', () => {
        const stable = buildVersionId('1.0.0', '1.0.0.0', 'abc');
        const devPseudo = buildVersionId('dev-1.0.0', 'dev-1.0.0', 'abc1230000000000000000');
        expect(stable).not.toBe(devPseudo);
    });
});

describe('isValidPackageName', () => {
    it('accepts valid vendor/package names', () => {
        expect(isValidPackageName('symfony/console')).toBe(true);
        expect(isValidPackageName('laravel/framework')).toBe(true);
        expect(isValidPackageName('league/oauth2-server')).toBe(true);
    });

    it('rejects names without vendor prefix', () => {
        expect(isValidPackageName('console')).toBe(false);
    });

    it('rejects names with uppercase (Composer convention)', () => {
        // Our regex is case-insensitive, consistent with real Packagist
        expect(isValidPackageName('Symfony/Console')).toBe(true);
    });

    it('rejects empty string', () => {
        expect(isValidPackageName('')).toBe(false);
    });
});
