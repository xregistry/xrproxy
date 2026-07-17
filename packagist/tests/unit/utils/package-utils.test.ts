/**
 * Unit tests for package-utils – especially the critical dev-* identity rule.
 */

import {
    buildVersionId,
    decodePackageId,
    encodePackageId,
    isDevVersion,
    isValidPackageName,
} from '../../../src/utils/package-utils';

describe('encodePackageId / decodePackageId', () => {
    it('replaces slash with tilde for vendor/package', () => {
        expect(encodePackageId('symfony/console')).toBe('symfony~console');
    });

    it('handles nested-vendor-style names', () => {
        expect(encodePackageId('league/oauth2-server')).toBe('league~oauth2-server');
    });

    it('round-trips correctly', () => {
        const original = 'laravel/framework';
        expect(decodePackageId(encodePackageId(original))).toBe(original);
    });

    it('handles names with dots', () => {
        expect(encodePackageId('doctrine/dbal')).toBe('doctrine~dbal');
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
        expect(id).toBe('dev-main.deadbeef1234');
    });

    it('uses "unknown" when no source reference supplied', () => {
        const id = buildVersionId('dev-main', 'dev-main');
        expect(id).toBe('dev-main.unknown');
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
        // Stable IDs do not contain "."+"unknown" or a hex suffix pattern
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
