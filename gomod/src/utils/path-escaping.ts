/**
 * Go module path escaping utilities
 *
 * Per the Go module proxy protocol, module paths with uppercase letters
 * must be escaped: each uppercase letter A is replaced with `!a` (exclamation
 * mark followed by the lowercase letter).
 *
 * References:
 *   https://pkg.go.dev/golang.org/x/mod/module#EscapePath
 *   https://pkg.go.dev/cmd/go#hdr-Module_proxy_protocol
 */

/**
 * Escape a Go module path or version for use in GOPROXY URLs.
 * Uppercase ASCII letters A–Z become `!` followed by the lowercase letter.
 *
 * @example
 *   escapePath('github.com/BurntSushi/toml') → 'github.com/!burnt!sushi/toml'
 *   escapePath('v1.2.3')                     → 'v1.2.3'
 */
export function escapePath(raw: string): string {
    return raw.replace(/[A-Z]/g, (c) => '!' + c.toLowerCase());
}

/**
 * Unescape a GOPROXY-escaped path back to its canonical form.
 * `!x` sequences become the uppercase equivalent of `x`.
 *
 * @example
 *   unescapePath('github.com/!burnt!sushi/toml') → 'github.com/BurntSushi/toml'
 */
export function unescapePath(escaped: string): string {
    return escaped.replace(/!([a-z])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Escape a module version string for GOPROXY URL segments.
 * Versions follow the same rules as paths.
 */
export function escapeVersion(version: string): string {
    return escapePath(version);
}

/**
 * Unescape a module version string from a GOPROXY URL segment.
 */
export function unescapeVersion(escaped: string): string {
    return unescapePath(escaped);
}

/**
 * Encode a canonical module path for an xRegistry URL while preserving its
 * slash-delimited structure. Encoding the whole path turns slashes into %2F,
 * which clients may encode again when following self links.
 */
export interface ModuleIdentity {
    groupId: string;
    moduleId: string;
}

/**
 * Map a Go module path onto the xRegistry Group/Resource hierarchy.
 *
 * The first module-path component is the registry group. Remaining path
 * components form one xRegistry-safe resource ID. Go module paths cannot
 * contain colons, so `:` is a reversible separator that avoids slash-bearing
 * entity IDs.
 */
export function modulePathToIdentity(modulePath: string): ModuleIdentity {
    const [groupId, ...remainder] = modulePath.split('/');
    if (!groupId || remainder.some(segment => !segment) || modulePath.includes(':') || modulePath.includes('@')) {
        throw new Error(`Invalid canonical Go module path: ${modulePath}`);
    }
    return {
        groupId,
        moduleId: remainder.length === 0 ? '@' : remainder.join(':'),
    };
}

/** Reconstruct a canonical Go module path from its xRegistry identity. */
export function identityToModulePath(groupId: string, moduleId: string): string {
    if (
        !groupId ||
        groupId.includes('/') ||
        groupId.includes(':') ||
        groupId.includes('@') ||
        !moduleId ||
        moduleId.includes('/') ||
        (moduleId !== '@' && (
            moduleId.includes('@') || moduleId.split(':').some(segment => !segment)
        ))
    ) {
        throw new Error(`Invalid Go module identity: ${groupId}/${moduleId}`);
    }
    const modulePath = moduleId === '@' ? groupId : `${groupId}/${moduleId.replace(/:/g, '/')}`;
    const roundTrip = modulePathToIdentity(modulePath);
    if (roundTrip.groupId !== groupId || roundTrip.moduleId !== moduleId) {
        throw new Error(`Non-canonical Go module identity: ${groupId}/${moduleId}`);
    }
    return modulePath;
}

/**
 * Validate that a module path is a syntactically valid Go module path.
 * This is a basic check; full validation is done by the Go toolchain.
 */
export function isValidModulePath(modulePath: string): boolean {
    if (!modulePath || modulePath.length === 0) return false;
    // Must not start with a slash
    if (modulePath.startsWith('/')) return false;
    // Must not contain double slashes
    if (modulePath.includes('//')) return false;
    // Basic domain check: first element must look like a hostname
    const parts = modulePath.split('/');
    if (parts.length === 0) return false;
    const host = parts[0];
    if (!host.includes('.') && host !== 'localhost') return false;
    return true;
}

/**
 * Detect whether a version string is a pseudo-version.
 * Pseudo-versions have the form vX.Y.Z-yyyymmddhhmmss-abcdefabcdef
 * or vX.Y.(Z+1)-0.yyyymmddhhmmss-abcdefabcdef
 *
 * @see https://go.dev/ref/mod#pseudo-versions
 */
export function isPseudoVersion(version: string): boolean {
    return /^v\d+\.\d+\.\d+-\d{14}-[0-9a-f]{12}$/.test(version) ||
           /^v\d+\.\d+\.\d+-0\.\d{14}-[0-9a-f]{12}$/.test(version) ||
           /^v\d+\.\d+\.\d+-\d+\.\d{14}-[0-9a-f]{12}$/.test(version);
}

/**
 * Extract the timestamp from a pseudo-version string.
 * Returns an ISO-8601 string or null if not a pseudo-version.
 */
export function pseudoVersionTimestamp(version: string): string | null {
    const m = version.match(/-(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})-[0-9a-f]{12}$/);
    if (!m) return null;
    return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
}

/**
 * Check whether a version is a pre-release (has a pre-release suffix, including pseudo-versions).
 */
export function isPreRelease(version: string): boolean {
    // SemVer pre-release or pseudo-version
    return /^v\d+\.\d+\.\d+-./.test(version);
}
