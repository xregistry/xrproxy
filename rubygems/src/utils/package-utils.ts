import { createHash } from 'node:crypto';
import { RUBYGEMS_API } from '../config/constants';

const ENTITY_ID_RE = /^[A-Za-z0-9._-]+$/;
const HASHED_VERSION_ID_PREFIX = 'xh~';
const MAX_ENTITY_ID_LENGTH = 128;
const SUFFIX_FREE_PLATFORM = 'ruby';

export function encodeGemName(name: string): string {
    return ENTITY_ID_RE.test(name) ? name : encodeURIComponent(name);
}

export function buildVersionId(version: string, platform: string): string {
    if (!platform || platform === SUFFIX_FREE_PLATFORM) {
        return version;
    }

    const composed = `${version}-${platform}`;
    if (
        composed.length <= MAX_ENTITY_ID_LENGTH
        && ENTITY_ID_RE.test(composed)
        && !composed.startsWith(HASHED_VERSION_ID_PREFIX)
    ) {
        return composed;
    }

    const payload = `${version}/${platform}`;
    return `${HASHED_VERSION_ID_PREFIX}${createHash('sha256').update(payload, 'utf8').digest('hex')}`;
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

export function buildFullName(name: string, version: string, platform: string): string {
    return !platform || platform === SUFFIX_FREE_PLATFORM
        ? `${name}-${version}`
        : `${name}-${version}-${platform}`;
}

/** Build the gem download URI for a given name, version, and platform. */
export function buildGemUri(name: string, version: string, platform: string): string {
    return `${RUBYGEMS_API.PUBLIC_URL}/gems/${buildFullName(name, version, platform)}.gem`;
}
