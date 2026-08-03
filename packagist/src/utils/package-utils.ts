/** Composer package and version identity helpers. */

import { createHash } from 'node:crypto';

export interface ComposerPackageIdentity {
    groupId: string;
    resourceId: string;
    canonicalName: string;
}

const COMPOSER_COMPONENT = /^[a-z0-9](?:[a-z0-9_.-]*[a-z0-9])?$/i;
const XREGISTRY_ID = /^[A-Za-z0-9_][A-Za-z0-9._~:@-]{0,127}$/;
const HASHED_VERSION_PREFIX = 'xh~';

function validPackageParts(name: string): [string, string] | null {
    const parts = name.split('/');
    if (
        parts.length !== 2 || !parts[0] || !parts[1] ||
        parts[0].length > 128 || parts[1].length > 128 ||
        !COMPOSER_COMPONENT.test(parts[0]) || !COMPOSER_COMPONENT.test(parts[1])
    ) return null;
    return [parts[0], parts[1]];
}

function isValidXRegistryId(id: string): boolean {
    return id.length <= 128 && XREGISTRY_ID.test(id);
}

function hashVersionIdentity(value: string): string {
    return `${HASHED_VERSION_PREFIX}${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

/** Map an upstream package name to its canonical lowercase Composer identity. */
export function packageNameToIdentity(name: string): ComposerPackageIdentity {
    const parts = validPackageParts(name);
    if (!parts) throw new Error(`Invalid Composer package name: ${name}`);
    const groupId = parts[0].toLowerCase();
    const resourceId = parts[1].toLowerCase();
    return { groupId, resourceId, canonicalName: `${groupId}/${resourceId}` };
}

/** Reconstruct a syntactically valid request name; upstream decides canonical case. */
export function identityToPackageName(groupId: string, resourceId: string): string {
    const name = `${groupId}/${resourceId}`;
    if (groupId.includes('/') || resourceId.includes('/') || !validPackageParts(name)) {
        throw new Error(`Invalid Composer xRegistry identity: ${name}`);
    }
    return name;
}

/** Decode the pre-#203 `vendor~package` resource ID for migration messages. */
export function decodeLegacyPackageId(id: string): ComposerPackageIdentity | null {
    const parts = id.split('~');
    if (parts.length !== 2) return null;
    try {
        return packageNameToIdentity(`${parts[0]}/${parts[1]}`);
    } catch {
        return null;
    }
}

export function isDevVersion(version: string): boolean {
    return version.startsWith('dev-') || version.endsWith('-dev');
}

function buildStableVersionId(version: string): string {
    if (isValidXRegistryId(version) && !version.startsWith(HASHED_VERSION_PREFIX)) {
        return version;
    }

    const plusSubstituted = version.replace(/\+/g, '~');
    if (isValidXRegistryId(plusSubstituted) && !plusSubstituted.startsWith(HASHED_VERSION_PREFIX)) {
        return plusSubstituted;
    }

    return hashVersionIdentity(version);
}

function buildDevVersionId(version: string, sourceRef?: string): string {
    const alias = version.replace(/\//g, '~');
    const candidate = `${alias}:${sourceRef ?? ''}`;
    if (isValidXRegistryId(candidate) && !candidate.startsWith(HASHED_VERSION_PREFIX)) {
        return candidate;
    }

    return hashVersionIdentity(`${version}/${sourceRef ?? ''}`);
}

/**
 * Build the xRegistry Version ID required by the Packagist extension spec.
 * Stable versions preserve the raw upstream version where possible. Mutable
 * dev aliases include the alias plus the full source reference.
 */
export function buildVersionId(version: string, _versionNormalized: string, sourceRef?: string): string {
    return isDevVersion(version)
        ? buildDevVersionId(version, sourceRef)
        : buildStableVersionId(version);
}

export function isValidPackageName(name: string): boolean {
    try {
        packageNameToIdentity(name);
        return true;
    } catch {
        return false;
    }
}
