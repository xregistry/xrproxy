/**
 * Package identity utilities for the npm xRegistry projection.
 */

import { createHash } from 'crypto';
import { GROUP_CONFIG } from '../config/constants';

const PACKAGE_ID_HASH_PREFIX = 'xh~';

/**
 * Properly encode package names for use against the upstream npm registry.
 */
export function encodePackageName(packageName: string): string {
    return encodeURIComponent(packageName).replace(/%40/g, '@');
}

/**
 * Properly encode package names for use in generic URL path segments.
 */
export function encodePackageNameForPath(packageName: string): string {
    return encodeURIComponent(packageName);
}

/**
 * Convert the legacy scoped-package placeholder form back to slash notation.
 */
export function convertTildeToSlash(packageName: string): string {
    if (!packageName || typeof packageName !== 'string') {
        return packageName;
    }
    return packageName.replace(/~/g, '/');
}

/**
 * Normalize a package name into the xRegistry packageid defined by the spec.
 */
export function normalizePackageId(packageName: string): string {
    if (!packageName || typeof packageName !== 'string') {
        return '_invalid';
    }
    return getPackageId(packageName);
}

/**
 * Normalize an npm version into the xRegistry versionid defined by the spec.
 */
export function normalizeVersionId(version: string): string {
    if (!version || typeof version !== 'string') {
        return '_invalid';
    }
    return version.replace(/\+/g, '~');
}

/**
 * Validate whether a package name is syntactically valid for npm.
 */
export function isValidPackageName(packageName: string): boolean {
    if (!packageName || typeof packageName !== 'string') {
        return false;
    }

    const scopedPattern = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;
    const regularPattern = /^[a-z0-9][a-z0-9._-]*$/;

    return scopedPattern.test(packageName) || regularPattern.test(packageName);
}

/**
 * Extract the npm scope without the leading @.
 */
export function extractScope(packageName: string): string | null {
    if (!packageName || typeof packageName !== 'string' || !packageName.startsWith('@')) {
        return null;
    }

    const slashIndex = packageName.indexOf('/');
    if (slashIndex <= 1) {
        return null;
    }

    return packageName.substring(1, slashIndex);
}

/**
 * Extract the unscoped portion of a package name.
 */
export function extractNameWithoutScope(packageName: string): string {
    if (!packageName || typeof packageName !== 'string' || !packageName.startsWith('@')) {
        return packageName;
    }

    const slashIndex = packageName.indexOf('/');
    if (slashIndex === -1) {
        return packageName;
    }

    return packageName.substring(slashIndex + 1);
}

/**
 * Get the xRegistry nodescopeid for a package.
 */
export function getNodescopeId(packageName: string): string {
    return extractScope(packageName) ?? GROUP_CONFIG.UNSCOPED_ID;
}

/**
 * Get the xRegistry packageid for a package.
 */
export function getPackageId(packageName: string): string {
    const unscopedName = extractNameWithoutScope(packageName);
    if (unscopedName.length <= 128) {
        return unscopedName;
    }

    const hash = createHash('sha256')
        .update(Buffer.from(unscopedName, 'utf8'))
        .digest('hex');

    return `${PACKAGE_ID_HASH_PREFIX}${hash}`;
}

/**
 * Build the canonical xRegistry xid for a package name.
 */
export function toPackageXid(packageName: string): string {
    return `/nodescopes/${getNodescopeId(packageName)}/packages/${getPackageId(packageName)}`;
}

/**
 * Determine whether a canonical npm package name matches a nodescope/packageid pair.
 */
export function matchesPackageIdentity(
    packageName: string,
    nodescopeId: string,
    packageId: string
): boolean {
    return getNodescopeId(packageName) === nodescopeId && getPackageId(packageName) === packageId;
}

/**
 * Resolve an upstream version string from a versionid by matching against known versions.
 */
export function findVersionById(versionId: string, versions: Iterable<string>): string | null {
    for (const version of versions) {
        if (normalizeVersionId(version) === versionId) {
            return version;
        }
    }
    return null;
}
