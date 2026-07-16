/**
 * xRegistry error types per RFC 9457 (Problem Details for HTTP APIs).
 */

export interface XRegistryError {
    type: string;
    title: string;
    status: number;
    instance: string;
    detail?: string;
    [key: string]: unknown;
}

const BASE = 'https://github.com/xregistry/spec/blob/main/core/spec.md';

function mkError(
    fragment: string,
    status: number,
    title: string,
    instance: string,
    detail?: string,
    ext?: Record<string, unknown>,
): XRegistryError {
    return { type: `${BASE}#${fragment}`, title, status, instance, ...(detail && { detail }), ...ext };
}

export function entityNotFound(instance: string, entityType: string, id: string): XRegistryError {
    return mkError('entity_not_found', 404, `${entityType} '${id}' not found`, instance,
        `No ${entityType} with id '${id}' exists in this registry`);
}

export function invalidData(instance: string, attr: string, reason: string): XRegistryError {
    return mkError('invalid_data', 400, `Invalid value for '${attr}'`, instance, reason);
}

export function internalError(instance: string, detail?: string): XRegistryError {
    return mkError('internal_error', 500, 'Internal server error', instance, detail);
}

export function serviceUnavailable(instance: string, detail?: string): XRegistryError {
    return mkError('service_unavailable', 502, 'Upstream service unavailable', instance, detail);
}

export function isXRegistryError(e: unknown): e is XRegistryError {
    return typeof e === 'object' && e !== null && 'status' in e && 'type' in e;
}
