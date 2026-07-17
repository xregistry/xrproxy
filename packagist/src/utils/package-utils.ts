/**
 * Package identity utilities for Packagist/Composer packages.
 *
 * Vendor/package naming:
 *   Packagist uses "vendor/package" format (slash-separated).
 *   xRegistry IDs may not contain slashes.
 *   We encode "/" → "~" to produce a collision-safe, reversible xRegistry ID.
 *
 * Version identity rules (CRITICAL):
 *   - Stable versions (e.g. 1.0.0, 2.3.1): immutable; use the normalized
 *     version string as the xRegistry versionid.
 *   - dev-* versions (e.g. dev-main, dev-master): MUTABLE branch aliases.
 *     Their identity depends on both the alias name AND the source reference
 *     (commit SHA). Two dev-main entries at different commits are different
 *     resources. ID format:  "<alias>.<sourceRef12>"  where sourceRef12 is
 *     the first 12 hex chars of the commit SHA (or "unknown" if absent).
 *     The human-readable display version (version) and sourceReference are
 *     exposed separately so consumers can distinguish alias from commit.
 */

/**
 * Encode a Packagist vendor/package name into a valid xRegistry resource ID.
 * "vendor/package-name" → "vendor~package-name"
 */
export function encodePackageId(vendorPackage: string): string {
    if (!vendorPackage) return '_invalid';
    return vendorPackage.replace(/\//g, '~').replace(/[^a-zA-Z0-9\-._~@]/g, '_');
}

/**
 * Decode an xRegistry resource ID back to a Packagist vendor/package name.
 * "vendor~package-name" → "vendor/package-name"
 */
export function decodePackageId(xregistryId: string): string {
    return xregistryId.replace(/~/g, '/');
}

/**
 * Return true when this is a Packagist dev-* branch alias.
 * "dev-main", "dev-master", "dev-feature-foo" etc.
 */
export function isDevVersion(version: string): boolean {
    return version.startsWith('dev-') || version.endsWith('-dev');
}

/**
 * Build a collision-safe, deterministic xRegistry versionid for a version.
 *
 * Stable  → normalized version string (e.g. "1.2.3.0")
 * Dev-*   → "<alias>.<firstTwelveOfRef>" (e.g. "dev-main.abc123def456")
 *            Falls back to "<alias>.unknown" when no source reference.
 *
 * The resulting ID contains only xRegistry-safe characters
 * (alphanumerics, hyphen, dot, underscore, tilde).
 */
export function buildVersionId(version: string, versionNormalized: string, sourceRef?: string): string {
    if (isDevVersion(version)) {
        const ref = sourceRef && /^[0-9a-f]{4,}/i.test(sourceRef)
            ? sourceRef.slice(0, 12).toLowerCase()
            : 'unknown';
        // Use the display version (e.g. "dev-main") with the ref appended
        const safeAlias = version.replace(/[^a-zA-Z0-9\-._~]/g, '_');
        return `${safeAlias}.${ref}`;
    }
    // Stable: prefer the Composer-normalized string (e.g. "1.2.3.0"), fall back to display
    const base = (versionNormalized || version).replace(/[^a-zA-Z0-9\-._~]/g, '_');
    return base;
}

/**
 * Validate a Packagist package name (vendor/package).
 */
export function isValidPackageName(name: string): boolean {
    return /^[a-z0-9]([a-z0-9_.-]*)?\/[a-z0-9]([a-z0-9_.-]*)?$/i.test(name);
}
