/**
 * Unit tests for path-escaping utilities.
 */

import {
    escapePath,
    escapeVersion,
    isPreRelease,
    isPseudoVersion,
    isValidModulePath,
    pseudoVersionTimestamp,
    unescapePath,
    unescapeVersion,
} from '../src/utils/path-escaping';

describe('escapePath', () => {
    it('leaves lowercase paths unchanged', () => {
        expect(escapePath('github.com/pkg/errors')).toBe('github.com/pkg/errors');
    });

    it('escapes uppercase letters with ! prefix', () => {
        expect(escapePath('github.com/BurntSushi/toml')).toBe(
            'github.com/!burnt!sushi/toml'
        );
    });

    it('escapes all uppercase letters in a string', () => {
        expect(escapePath('github.com/Azure/azure-sdk-for-go')).toBe(
            'github.com/!azure/azure-sdk-for-go'
        );
    });

    it('handles version strings with no uppercase', () => {
        expect(escapeVersion('v1.2.3')).toBe('v1.2.3');
    });
});

describe('unescapePath', () => {
    it('reverses !x sequences to uppercase', () => {
        expect(unescapePath('github.com/!burnt!sushi/toml')).toBe(
            'github.com/BurntSushi/toml'
        );
    });

    it('is a no-op for paths with no escaping', () => {
        expect(unescapePath('github.com/pkg/errors')).toBe('github.com/pkg/errors');
    });

    it('is the inverse of escapePath', () => {
        const original = 'github.com/BurntSushi/toml';
        expect(unescapePath(escapePath(original))).toBe(original);
    });
});

describe('unescapeVersion', () => {
    it('is the inverse of escapeVersion', () => {
        const v = 'v1.2.3-Pre.Release';
        expect(unescapeVersion(escapeVersion(v))).toBe(v);
    });
});

describe('isValidModulePath', () => {
    it('accepts standard module paths', () => {
        expect(isValidModulePath('github.com/pkg/errors')).toBe(true);
        expect(isValidModulePath('golang.org/x/net')).toBe(true);
    });

    it('rejects empty string', () => {
        expect(isValidModulePath('')).toBe(false);
    });

    it('rejects paths starting with slash', () => {
        expect(isValidModulePath('/github.com/pkg/errors')).toBe(false);
    });

    it('rejects double slashes', () => {
        expect(isValidModulePath('github.com//pkg/errors')).toBe(false);
    });
});

describe('isPseudoVersion', () => {
    it('detects standard pseudo-versions', () => {
        expect(
            isPseudoVersion('v0.0.0-20210405180319-a5a99cb37ef4')
        ).toBe(true);
    });

    it('returns false for release versions', () => {
        expect(isPseudoVersion('v1.2.3')).toBe(false);
    });

    it('returns false for pre-release non-pseudo versions', () => {
        expect(isPseudoVersion('v1.0.0-alpha.1')).toBe(false);
    });
});

describe('pseudoVersionTimestamp', () => {
    it('extracts the timestamp from a pseudo-version', () => {
        expect(
            pseudoVersionTimestamp('v0.0.0-20210405180319-a5a99cb37ef4')
        ).toBe('2021-04-05T18:03:19Z');
    });

    it('returns null for non-pseudo versions', () => {
        expect(pseudoVersionTimestamp('v1.2.3')).toBeNull();
    });
});

describe('isPreRelease', () => {
    it('returns true for pseudo-versions', () => {
        expect(isPreRelease('v0.0.0-20210405180319-a5a99cb37ef4')).toBe(true);
    });

    it('returns true for alpha/beta pre-releases', () => {
        expect(isPreRelease('v1.0.0-alpha.1')).toBe(true);
    });

    it('returns false for stable releases', () => {
        expect(isPreRelease('v1.2.3')).toBe(false);
    });
});
