/**
 * Unit tests for package utilities.
 */

import { createHash } from 'crypto';
import {
    encodePackageName,
    extractNameWithoutScope,
    extractScope,
    findVersionById,
    getNodescopeId,
    isValidPackageName,
    matchesPackageIdentity,
    normalizePackageId,
    normalizeVersionId,
    toPackageXid,
} from '../../../src/utils/package-utils';

describe('Package Utilities', () => {
    test('encodes scoped package names for upstream npm requests', () => {
        expect(encodePackageName('@types/node')).toBe('@types%2Fnode');
        expect(encodePackageName('express')).toBe('express');
    });

    test('extracts scope without the leading at sign', () => {
        expect(extractScope('@babel/core')).toBe('babel');
        expect(extractScope('express')).toBeNull();
    });

    test('extracts the unscoped package name', () => {
        expect(extractNameWithoutScope('@babel/core')).toBe('core');
        expect(extractNameWithoutScope('express')).toBe('express');
    });

    test('maps scoped and unscoped packages to nodescope ids', () => {
        expect(getNodescopeId('@babel/core')).toBe('babel');
        expect(getNodescopeId('express')).toBe('_');
    });

    test('uses the unscoped portion as packageid', () => {
        expect(normalizePackageId('@babel/core')).toBe('core');
        expect(normalizePackageId('express')).toBe('express');
    });

    test('hashes package ids longer than 128 characters', () => {
        const unscopedName = 'a'.repeat(129);
        const expected = 'xh~' + createHash('sha256').update(Buffer.from(unscopedName, 'utf8')).digest('hex');
        expect(normalizePackageId(`@scope/${unscopedName}`)).toBe(expected);
    });

    test('maps build metadata versions by replacing plus with tilde', () => {
        expect(normalizeVersionId('1.0.0+build.1')).toBe('1.0.0~build.1');
        expect(normalizeVersionId('1.0.0')).toBe('1.0.0');
    });

    test('builds package xids from nodescope and packageid', () => {
        expect(toPackageXid('@babel/core')).toBe('/nodescopes/babel/packages/core');
        expect(toPackageXid('express')).toBe('/nodescopes/_/packages/express');
    });

    test('matches canonical package identities', () => {
        expect(matchesPackageIdentity('@babel/core', 'babel', 'core')).toBe(true);
        expect(matchesPackageIdentity('express', '_', 'express')).toBe(true);
        expect(matchesPackageIdentity('@babel/core', '_', 'core')).toBe(false);
    });

    test('finds upstream versions from version ids', () => {
        expect(findVersionById('1.0.0~build.1', ['1.0.0', '1.0.0+build.1'])).toBe('1.0.0+build.1');
        expect(findVersionById('2.0.0', ['1.0.0'])).toBeNull();
    });

    test('validates npm package names', () => {
        expect(isValidPackageName('@babel/core')).toBe(true);
        expect(isValidPackageName('express')).toBe(true);
        expect(isValidPackageName('UPPER CASE')).toBe(false);
    });
});
