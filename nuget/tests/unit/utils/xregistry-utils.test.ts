import { generateETag, generateXRegistryEntity, handleEpochFlag, handleInlineFlag, handleNoReadonlyFlag, handleSchemaFlag, isValidSelfUrl, isValidXRegistryId, parseFilterExpressions } from '../../../src/utils/xregistry-utils';

const createMockRequest = (query: Record<string, unknown> = {}) => ({ query, protocol: 'http', get: (header: string) => header === 'host' ? 'localhost:3300' : undefined, path: '/test' }) as any;

describe('xRegistry Utilities', () => {
    test('generates a valid xRegistry entity for a NuGet package path', () => {
        const entity = generateXRegistryEntity({ id: 'newtonsoft.json', name: 'Newtonsoft.Json', description: 'JSON framework', parentUrl: '/dotnetregistries/nuget/packages', type: 'package' });
        expect(entity.xid).toBe('/dotnetregistries/nuget/packages/newtonsoft.json');
        expect(entity.self).toMatch(/^http:\/\/localhost:3300\/dotnetregistries\/nuget\/packages\/newtonsoft\.json$/);
        expect(entity).toBeValidXRegistryEntity();
    });

    test('parses filter expressions', () => {
        expect(parseFilterExpressions(['name=Newtonsoft.Json', 'packageid!=foo'])).toEqual([{ attribute: 'name', operator: '=', value: 'Newtonsoft.Json' }, { attribute: 'packageid', operator: '!=', value: 'foo' }]);
    });

    test('applies inline, epoch, readonly, and schema flags consistently', () => {
        const base = { xid: '/dotnetregistries/nuget/packages/newtonsoft.json', self: 'http://localhost:3300/dotnetregistries/nuget/packages/newtonsoft.json', epoch: 1, createdat: '2023-01-01T00:00:00Z', modifiedat: '2023-01-01T00:00:00Z', readonly: true };
        expect(handleInlineFlag(createMockRequest({ inline: 'true' }), base)).toMatchObject({ _inlined: true });
        expect(handleEpochFlag(createMockRequest({ noepoch: 'true' }), base)).not.toHaveProperty('epoch');
        expect(handleNoReadonlyFlag(createMockRequest({ noreadonly: 'true' }), base)).not.toHaveProperty('readonly');
        expect(handleSchemaFlag(createMockRequest({ schema: 'true' }), base, 'resource')).toMatchObject({ $schema: 'xRegistry-json/1.0-rc2/resource' });
    });

    test('validates canonical xRegistry ids and self URLs', () => {
        expect(isValidXRegistryId('/dotnetregistries/nuget/packages/newtonsoft.json')).toBe(true);
        expect(isValidXRegistryId('/dotnetregistries/nuget/packages/example/versions/1.0.0~build.5')).toBe(true);
        expect(isValidXRegistryId('dotnetregistries/nuget')).toBe(false);
        expect(isValidSelfUrl('https://example.com/dotnetregistries/nuget/packages/newtonsoft.json')).toBe(true);
        expect(isValidSelfUrl('not-a-url')).toBe(false);
    });

    test('generates deterministic etags', () => {
        const etag = generateETag({ modifiedat: '2023-01-01T00:00:00Z', name: 'Newtonsoft.Json' });
        expect(etag).toMatch(/^\"[a-z0-9]+-\d+\"$/);
    });
});
