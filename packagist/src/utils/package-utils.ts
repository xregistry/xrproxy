/** Composer package and version identity helpers. */

import { createHash } from 'node:crypto';

export interface ComposerPackageIdentity {
    groupId: string;
    resourceId: string;
    canonicalName: string;
}

const COMPOSER_COMPONENT = /^[a-z0-9](?:[a-z0-9_.-]*[a-z0-9])?$/i;
const XREGISTRY_ID = /^[A-Za-z0-9_][A-Za-z0-9._~:@-]{0,127}$/;
const ENCODED_VERSION_PREFIX = 'xv~';

function validPackageParts(name: string): [string, string] | null {
    const parts = name.split('/');
    if (
        parts.length !== 2 || !parts[0] || !parts[1] ||
        parts[0].length > 128 || parts[1].length > 128 ||
        !COMPOSER_COMPONENT.test(parts[0]) || !COMPOSER_COMPONENT.test(parts[1])
    ) return null;
    return [parts[0], parts[1]];
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

function base64url(value: string): string {
    return Buffer.from(value, 'utf8').toString('base64url');
}

/**
 * Build a deterministic xRegistry-safe ID. Dev IDs reversibly encode the full
 * raw alias and full source reference, avoiding both sanitization and truncated
 * commit collisions. Stable normalized IDs remain unchanged when already safe.
 */
export function buildVersionId(version: string, versionNormalized: string, sourceRef?: string): string {
    let id: string;
    if (isDevVersion(version)) {
        id = `${ENCODED_VERSION_PREFIX}d~${base64url(version)}~${base64url(sourceRef ?? '')}`;
        if (!XREGISTRY_ID.test(id)) {
            // Composer branch aliases can approach xRegistry's 128-character
            // Entity-ID limit before adding a source reference. Preserve a
            // fixed-size, collision-resistant identity over the full tuple;
            // the raw alias and source reference remain on the Version entity.
            const digest = createHash('sha256')
                .update(`${version.length}:`)
                .update(version)
                .update(`${(sourceRef ?? '').length}:`)
                .update(sourceRef ?? '')
                .digest('base64url');
            id = `${ENCODED_VERSION_PREFIX}d~h~${digest}`;
        }
    } else {
        const normalized = versionNormalized || version;
        id = XREGISTRY_ID.test(normalized) && !normalized.startsWith(ENCODED_VERSION_PREFIX)
            ? normalized
            : `${ENCODED_VERSION_PREFIX}s~${base64url(normalized)}`;
        if (!XREGISTRY_ID.test(id)) {
            const digest = createHash('sha256').update(normalized).digest('base64url');
            id = `${ENCODED_VERSION_PREFIX}s~h~${digest}`;
        }
    }
    if (!XREGISTRY_ID.test(id)) {
        throw new Error(`Composer version cannot be represented as an xRegistry ID: ${version}`);
    }
    return id;
}

export function isValidPackageName(name: string): boolean {
    try {
        packageNameToIdentity(name);
        return true;
    } catch {
        return false;
    }
}
