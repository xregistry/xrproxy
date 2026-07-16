// Only the canonical 'ruby' platform is suffix-free in xRegistry version IDs.
// Every other platform — including 'jruby' — gets a '-<platform>' suffix so
// that the same version string on different platforms never collides.
const SUFFIX_FREE_PLATFORM = 'ruby';

export function encodeGemName(name: string): string {
    return encodeURIComponent(name).replace(/%40/g, '@');
}

export function buildVersionId(version: string, platform: string): string {
    if (!platform || platform === SUFFIX_FREE_PLATFORM) {
        return version;
    }
    const safePlatform = platform.replace(/\//g, '-').replace(/\s+/g, '-');
    return `${version}-${safePlatform}`;
}

export function parseVersionId(versionId: string, knownVersions?: Array<{ number: string; platform: string }>): { version: string; platform: string } {
    if (knownVersions) {
        for (const candidate of knownVersions) {
            if (buildVersionId(candidate.number, candidate.platform) === versionId) {
                return { version: candidate.number, platform: candidate.platform || SUFFIX_FREE_PLATFORM };
            }
        }
    }
    return { version: versionId, platform: SUFFIX_FREE_PLATFORM };
}

/**
 * Build the gem download URI for a given name, version, and platform.
 * Only the empty string and the canonical `ruby` platform produce a plain
 * `{name}-{version}.gem` filename. Every other platform — including `jruby` —
 * appends `-{platform}` before the `.gem` extension.
 */
export function buildGemUri(name: string, version: string, platform: string): string {
    const suffix = !platform || platform === SUFFIX_FREE_PLATFORM ? '' : `-${platform}`;
    return `https://rubygems.org/gems/${name}-${version}${suffix}.gem`;
}
