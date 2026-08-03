import { createHash } from 'crypto';

const MAX_ENTITY_ID_LENGTH = 128;
const HASH_PREFIX = 'xh~';
const ENTITY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/;

function sha256Hex(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function buildHashedEntityId(value: string): string {
    return `${HASH_PREFIX}${sha256Hex(value)}`;
}

export function isHashedIdentity(value: string): boolean {
    return value.startsWith(HASH_PREFIX) && /^[a-f0-9]{64}$/.test(value.slice(HASH_PREFIX.length));
}

export function isVerbatimEntityId(value: string): boolean {
    return value.length > 0 && value.length <= MAX_ENTITY_ID_LENGTH && ENTITY_ID_PATTERN.test(value);
}

export function toVersionId(version: string): string {
    return isVerbatimEntityId(version) ? version : buildHashedEntityId(version);
}

export function buildPackageIdMap(artifactIds: string[]): Map<string, string> {
    const result = new Map<string, string>();
    const byLower = new Map<string, string[]>();

    for (const artifactId of artifactIds) {
        const key = artifactId.toLowerCase();
        const bucket = byLower.get(key) ?? [];
        bucket.push(artifactId);
        byLower.set(key, bucket);
    }

    for (const bucket of byLower.values()) {
        bucket.sort((left, right) => left.localeCompare(right));
        const winner = bucket[0];
        for (const artifactId of bucket) {
            if (!isVerbatimEntityId(artifactId)) {
                result.set(artifactId, buildHashedEntityId(artifactId));
                continue;
            }
            if (bucket.length > 1 && artifactId !== winner) {
                result.set(artifactId, buildHashedEntityId(artifactId));
                continue;
            }
            result.set(artifactId, artifactId);
        }
    }

    return result;
}

export function buildNamespaceIdMap(groupIds: string[]): Map<string, string> {
    const result = new Map<string, string>();
    const byLower = new Map<string, string[]>();

    for (const groupId of groupIds) {
        const key = groupId.toLowerCase();
        const bucket = byLower.get(key) ?? [];
        bucket.push(groupId);
        byLower.set(key, bucket);
    }

    for (const bucket of byLower.values()) {
        bucket.sort((left, right) => left.localeCompare(right));
        const winner = bucket[0];
        for (const groupId of bucket) {
            if (!isVerbatimEntityId(groupId)) {
                result.set(groupId, buildHashedEntityId(groupId));
                continue;
            }
            if (bucket.length > 1 && groupId !== winner) {
                result.set(groupId, buildHashedEntityId(groupId));
                continue;
            }
            result.set(groupId, groupId);
        }
    }

    return result;
}
