/**
 * Go module path and version identity helpers.
 *
 * Go module identity is defined by the canonical, case-sensitive module path.
 * GOPROXY transport uses a filesystem-safe `!lower` escaping for uppercase
 * letters, while xRegistry addresses modules through a group/resource split.
 */

import { createHash } from 'node:crypto';

const HASH_PREFIX = 'xh~';
const MAX_ENTITY_ID_LENGTH = 128;

/**
 * Escape a Go module path or version for use in GOPROXY URLs.
 * Uppercase ASCII letters A–Z become `!` followed by the lowercase letter.
 */
export function escapePath(raw: string): string {
    return raw.replace(/[A-Z]/g, (c) => '!' + c.toLowerCase());
}

/**
 * Unescape a GOPROXY-escaped path back to its canonical form.
 * `!x` sequences become the uppercase equivalent of `x`.
 */
export function unescapePath(escaped: string): string {
    return escaped.replace(/!([a-z])/g, (_, c: string) => c.toUpperCase());
}

/** Escape a module version string for GOPROXY URL segments. */
export function escapeVersion(version: string): string {
    return escapePath(version);
}

/** Unescape a module version string from a GOPROXY URL segment. */
export function unescapeVersion(escaped: string): string {
    return unescapePath(escaped);
}

export interface ModuleIdentity {
    groupId: string;
    moduleId: string;
}

export interface ModuleIdentityOptions {
    collidingModulePaths?: string[];
}

function hashModulePath(modulePath: string): string {
    return `${HASH_PREFIX}${createHash('sha256').update(modulePath, 'utf8').digest('hex')}`;
}

function validateCanonicalModulePath(modulePath: string): string[] {
    if (!modulePath || modulePath.startsWith('/') || modulePath.endsWith('/')) {
        throw new Error(`Invalid canonical Go module path: ${modulePath}`);
    }

    if (modulePath.includes('//') || modulePath.includes(':') || modulePath.includes('@')) {
        throw new Error(`Invalid canonical Go module path: ${modulePath}`);
    }

    const parts = modulePath.split('/');
    if (parts.some((segment) => segment.length === 0)) {
        throw new Error(`Invalid canonical Go module path: ${modulePath}`);
    }

    return parts;
}

function canonicalModuleIdFromParts(parts: string[]): string {
    const [, ...remainder] = parts;
    return remainder.length === 0 ? '@' : remainder.join(':');
}

function collidingPaths(modulePath: string, allModulePaths: string[]): string[] {
    const parts = validateCanonicalModulePath(modulePath);
    const groupId = parts[0];
    const baseModuleId = canonicalModuleIdFromParts(parts).toLowerCase();

    return allModulePaths
        .filter((candidate) => {
            const candidateParts = validateCanonicalModulePath(candidate);
            return candidateParts[0] === groupId
                && canonicalModuleIdFromParts(candidateParts).toLowerCase() === baseModuleId;
        })
        .sort();
}

/**
 * Map a canonical Go module path onto the xRegistry Group/Resource hierarchy.
 *
 * The first path component becomes `goregistryid`. Remaining `/` separators are
 * replaced with `:` unless the identity would exceed xRegistry's 128-character
 * entity ID limit or would collide case-insensitively within its parent.
 */
export function modulePathToIdentity(modulePath: string, options: ModuleIdentityOptions = {}): ModuleIdentity {
    const parts = validateCanonicalModulePath(modulePath);
    const groupId = parts[0];
    const baseModuleId = canonicalModuleIdFromParts(parts);

    let moduleId = baseModuleId;
    if (baseModuleId.length > MAX_ENTITY_ID_LENGTH) {
        moduleId = hashModulePath(modulePath);
    } else if (options.collidingModulePaths?.length) {
        const collisions = collidingPaths(modulePath, options.collidingModulePaths);
        if (collisions.length > 1 && collisions[0] !== modulePath) {
            moduleId = hashModulePath(modulePath);
        }
    }

    return { groupId, moduleId };
}

/** Reconstruct a canonical Go module path from a reversible xRegistry identity. */
export function identityToModulePath(groupId: string, moduleId: string): string {
    const canonicalGroupId = unescapePath(groupId);
    const canonicalModuleId = unescapePath(moduleId);

    if (
        !canonicalGroupId
        || canonicalGroupId.includes('/')
        || canonicalGroupId.includes(':')
        || canonicalGroupId.includes('@')
        || !canonicalModuleId
        || canonicalModuleId.includes('/')
        || canonicalModuleId.startsWith('xh~')
        || (canonicalModuleId !== '@' && (
            canonicalModuleId.includes('@') || canonicalModuleId.split(':').some((segment) => !segment)
        ))
    ) {
        throw new Error(`Invalid Go module identity: ${groupId}/${moduleId}`);
    }

    const modulePath = canonicalModuleId === '@'
        ? canonicalGroupId
        : `${canonicalGroupId}/${canonicalModuleId.replace(/:/g, '/')}`;
    validateCanonicalModulePath(modulePath);
    return modulePath;
}

/** Returns whether a module identity uses the reserved hashed fallback form. */
export function isHashedModuleId(moduleId: string): boolean {
    return /^xh~[0-9a-f]{64}$/.test(moduleId);
}

/** Convert a canonical Go version string into an xRegistry versionid. */
export function versionToId(version: string): string {
    return version.replace(/\+/g, '~');
}

/** Convert an xRegistry versionid back into the canonical upstream Go version. */
export function versionIdToVersion(versionId: string): string {
    return unescapeVersion(versionId).replace(/~/g, '+');
}

/** Extract the /vN major-version suffix from a module path, when present. */
export function majorVersionSuffix(modulePath: string): string | undefined {
    const match = modulePath.match(/(\/v[2-9]\d*)$/);
    return match?.[1];
}

/** Whether the canonical upstream version carries the +incompatible suffix. */
export function isIncompatibleVersion(version: string): boolean {
    return version.includes('+incompatible');
}

/**
 * Validate that a module path is a syntactically valid canonical Go module path.
 * This is intentionally lighter than the Go toolchain's own parser.
 */
export function isValidModulePath(modulePath: string): boolean {
    try {
        const parts = validateCanonicalModulePath(modulePath);
        const host = parts[0];
        return host.includes('.') || host === 'localhost' || host === 'example' || host === 'test';
    } catch {
        return false;
    }
}

/**
 * Detect whether a version string is a pseudo-version.
 *
 * Pseudo-versions have the form vX.Y.Z-yyyymmddhhmmss-abcdefabcdef
 * or vX.Y.(Z+1)-0.yyyymmddhhmmss-abcdefabcdef.
 */
export function isPseudoVersion(version: string): boolean {
    return /^v\d+\.\d+\.\d+-\d{14}-[0-9a-f]{12}$/.test(version)
        || /^v\d+\.\d+\.\d+-0\.\d{14}-[0-9a-f]{12}$/.test(version)
        || /^v\d+\.\d+\.\d+-\d+\.\d{14}-[0-9a-f]{12}$/.test(version);
}

/** Extract the timestamp from a pseudo-version string. */
export function pseudoVersionTimestamp(version: string): string | null {
    const m = version.match(/-(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})-[0-9a-f]{12}$/);
    if (!m) return null;
    return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
}

/** Check whether a version is a pre-release (including pseudo-versions). */
export function isPreRelease(version: string): boolean {
    return /^v\d+\.\d+\.\d+-./.test(version);
}
