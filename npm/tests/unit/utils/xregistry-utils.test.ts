/**
 * Unit tests for xRegistry utilities.
 */

import {
    generateETag,
    generateXRegistryEntity,
    handleEpochFlag,
    handleInlineFlag,
    handleNoReadonlyFlag,
    handleSchemaFlag,
    isValidSelfUrl,
    isValidXRegistryId,
    parseFilterExpressions,
} from '../../../src/utils/xregistry-utils';

const createMockRequest = (query: Record<string, any> = {}) => ({
    query,
    protocol: 'http',
    get: (header: string) => header === 'host' ? 'localhost:3100' : undefined,
    path: '/test',
}) as any;

describe('xRegistry Utilities', () => {
    test('generates package entities without percent-encoded ids', () => {
        const entity = generateXRegistryEntity({
            id: 'core',
            name: '@babel/core',
            parentUrl: '/nodescopes/babel/packages',
            type: 'package',
        });

        expect(entity.xid).toBe('/nodescopes/babel/packages/core');
        expect(entity.self).toBe('http://localhost:3100/nodescopes/babel/packages/core');
    });

    test('handles inline, epoch, and readonly flags', () => {
        expect(handleInlineFlag(createMockRequest({ inline: 'true' }), { name: 'x' })).toHaveProperty('_inlined', true);
        expect(handleEpochFlag(createMockRequest({ noepoch: 'true' }), { epoch: 1 })).not.toHaveProperty('epoch');
        expect(handleNoReadonlyFlag(createMockRequest({ noreadonly: 'true' }), { createdat: 'x', modifiedat: 'y', readonly: true })).toEqual({});
    });

    test('adds schema metadata using the configured schema version', () => {
        expect(handleSchemaFlag(createMockRequest({ schema: 'true' }), { name: 'x' }, 'resource')).toHaveProperty('$schema', 'xRegistry-json/1.0-rc2/resource');
    });

    test('validates xregistry ids and urls', () => {
        expect(isValidXRegistryId('/nodescopes/_/packages/express')).toBe(true);
        expect(isValidXRegistryId('/nodescopes/%40bad')).toBe(false);
        expect(isValidSelfUrl('https://example.com/path')).toBe(true);
        expect(isValidSelfUrl('ftp://example.com/path')).toBe(false);
    });

    test('generates stable etags', () => {
        expect(generateETag({ name: 'test', modifiedat: '2023-01-01T00:00:00Z' })).toMatch(/^"[a-z0-9]+-\d+"$/);
    });

    test('parses filter expressions', () => {
        expect(parseFilterExpressions(['name=express', 'packageid!=core'])).toEqual([
            { attribute: 'name', operator: '=', value: 'express' },
            { attribute: 'packageid', operator: '!=', value: 'core' },
        ]);
    });
});
