/**
 * xRegistry entity builder utilities.
 */

import { createHash } from 'node:crypto';
import { Request } from 'express';
import { getBaseUrl } from '../config/constants';

export interface EntityBase {
    xid: string;
    self: string;
    name?: string;
    description?: string;
    epoch?: number;
    createdat?: string;
    modifiedat?: string;
    [key: string]: unknown;
}

export function buildBaseEntity(xid: string, self: string, extra: Record<string, unknown> = {}): EntityBase {
    const now = new Date().toISOString();
    return {
        xid,
        self,
        epoch: 1,
        createdat: now,
        modifiedat: now,
        ...extra,
    };
}

/** Inject Content-Type with xRegistry schema parameter. */
export function setXRegistryContentType(res: { setHeader(k: string, v: string): void }): void {
    // schema parameter value must be quoted per RFC 7230 since it contains : and /
    res.setHeader('Content-Type', 'application/json; schema="https://xregistry.io/schemas/xregistry-v1.0-rc2.json"');
}

/**
 * Compute a stable, deterministic ETag for an entity using a SHA-256 content
 * hash. The same entity content always yields the same ETag, enabling reliable
 * If-None-Match / 304 handling.
 */
export function entityETag(entity: unknown): string {
    return '"' + createHash('sha256').update(JSON.stringify(entity)).digest('base64url').slice(0, 27) + '"';
}

export { getBaseUrl };

/** Return the base URL string appropriate for self-referencing links. */
export function getSelfBaseUrl(req: Request): string {
    return getBaseUrl(req);
}
