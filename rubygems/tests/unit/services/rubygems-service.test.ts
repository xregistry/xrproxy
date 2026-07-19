import * as path from 'node:path';
import * as fs from 'node:fs';
import { startFixtureServer } from '@xregistry/registry-core';
import { RubyGemsService } from '../../../src/services/rubygems-service';
import { buildGemUri, buildVersionId, parseVersionId } from '../../../src/utils/package-utils';
import { NOKOGIRI_VERSIONS_FIXTURE, RACK_GEM_FIXTURE, RACK_VERSIONS_FIXTURE } from '../../fixtures/rubygems-fixtures';

describe('RubyGemsService', () => {
    const cacheDir = path.join(process.cwd(), 'tests', '.cache-rubygems-service');

    beforeEach(() => {
        fs.rmSync(cacheDir, { recursive: true, force: true });
    });

    afterEach(() => {
        fs.rmSync(cacheDir, { recursive: true, force: true });
    });

    test('fetches gem metadata from upstream', async () => {
        const fixture = await startFixtureServer([
            { path: '/gems/rack.json', responses: [{ body: RACK_GEM_FIXTURE }] },
        ]);
        try {
            const service = new RubyGemsService({ cacheDir, baseUrl: fixture.url });
            const result = await service.getGem('rack');
            expect(result).toEqual(RACK_GEM_FIXTURE);
            expect(fixture.requests).toHaveLength(1);
            expect(fixture.requests[0]?.path).toBe('/gems/rack.json');
        } finally {
            await fixture.close();
        }
    });

    test('fetches version listing from upstream', async () => {
        const fixture = await startFixtureServer([
            { path: '/versions/rack.json', responses: [{ body: RACK_VERSIONS_FIXTURE }] },
        ]);
        try {
            const service = new RubyGemsService({ cacheDir, baseUrl: fixture.url });
            const result = await service.getVersions('rack');
            expect(result).toEqual(RACK_VERSIONS_FIXTURE);
        } finally {
            await fixture.close();
        }
    });

    test('search accepts pages beyond the former fixed five-page limit', async () => {
        const fixture = await startFixtureServer([
            { path: '/search.json', responses: [{ body: [RACK_GEM_FIXTURE] }] },
        ]);
        try {
            const service = new RubyGemsService({ cacheDir, baseUrl: fixture.url });
            const result = await service.searchGems('rack', 6);

            expect(result).toEqual([RACK_GEM_FIXTURE]);
            expect(fixture.requests).toHaveLength(1);
        } finally {
            await fixture.close();
        }
    });

    test('ruby platform produces a plain version ID (no suffix)', () => {
        expect(buildVersionId('1.0.0', 'ruby')).toBe('1.0.0');
    });

    test('jruby platform produces a suffixed version ID (collision-safe)', () => {
        expect(buildVersionId('1.0.0', 'jruby')).toBe('1.0.0-jruby');
    });

    test('ruby and jruby produce distinct IDs for the same version (regression)', () => {
        const rubyId = buildVersionId('1.0.0', 'ruby');
        const jrubyId = buildVersionId('1.0.0', 'jruby');
        expect(rubyId).not.toBe(jrubyId);
    });

    test('x86_64-linux platform produces a suffixed version ID', () => {
        expect(buildVersionId('1.0.0', 'x86_64-linux')).toBe('1.0.0-x86_64-linux');
    });

    test('buildGemUri: ruby platform produces a plain gem filename (no suffix)', () => {
        expect(buildGemUri('nokogiri', '1.18.0', 'ruby')).toBe(
            'https://rubygems.org/gems/nokogiri-1.18.0.gem'
        );
    });

    test('buildGemUri: empty platform produces a plain gem filename (no suffix)', () => {
        expect(buildGemUri('rack', '3.1.0', '')).toBe(
            'https://rubygems.org/gems/rack-3.1.0.gem'
        );
    });

    test('buildGemUri: jruby platform produces a suffixed gem filename (regression)', () => {
        expect(buildGemUri('nokogiri', '1.18.0', 'jruby')).toBe(
            'https://rubygems.org/gems/nokogiri-1.18.0-jruby.gem'
        );
    });

    test('buildGemUri: x86_64-linux platform produces a suffixed gem filename', () => {
        expect(buildGemUri('nokogiri', '1.18.0', 'x86_64-linux')).toBe(
            'https://rubygems.org/gems/nokogiri-1.18.0-x86_64-linux.gem'
        );
    });

    test('parses version IDs back to number and platform', () => {
        const versionId = buildVersionId('1.18.0', 'arm64-darwin');
        expect(parseVersionId(versionId, NOKOGIRI_VERSIONS_FIXTURE)).toEqual({
            version: '1.18.0',
            platform: 'arm64-darwin',
        });
    });

    test('cache returns hit on second call without upstream request', async () => {
        const fixture = await startFixtureServer([
            { path: '/gems/rack.json', responses: [{ body: RACK_GEM_FIXTURE }, { body: RACK_GEM_FIXTURE }] },
        ]);
        try {
            const service = new RubyGemsService({ cacheDir, baseUrl: fixture.url });
            await service.getGem('rack');
            await service.getGem('rack');
            // Only one upstream request due to in-flight dedup + cache
            expect(fixture.requests).toHaveLength(1);
        } finally {
            await fixture.close();
        }
    });

    test('returns null for a missing gem (404)', async () => {
        const fixture = await startFixtureServer([
            { path: '/gems/missing-gem.json', responses: [{ status: 404, body: { error: 'not found' } }] },
        ]);
        try {
            const service = new RubyGemsService({ cacheDir, baseUrl: fixture.url });
            await expect(service.getGem('missing-gem')).resolves.toBeNull();
        } finally {
            await fixture.close();
        }
    });

    test('retries once for 503 then succeeds', async () => {
        const fixture = await startFixtureServer([
            {
                path: '/gems/rack.json',
                responses: [
                    { status: 503, body: { error: 'service unavailable' } },
                    { body: RACK_GEM_FIXTURE },
                ],
            },
        ]);
        try {
            const service = new RubyGemsService({ cacheDir, baseUrl: fixture.url });
            const result = await service.getGem('rack');
            expect(result).toEqual(RACK_GEM_FIXTURE);
            expect(fixture.requests).toHaveLength(2);
        } finally {
            await fixture.close();
        }
    });
});
