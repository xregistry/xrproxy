/**
 * xRegistry error helpers (RFC 9457 Problem Details).
 *
 * Upstream error types are re-exported from @xregistry/registry-core so the
 * rest of the service imports a single module.
 */

export { UpstreamError, isUpstreamError } from '@xregistry/registry-core';

const BASE = 'https://github.com/xregistry/spec/blob/main/core/spec.md';

export interface XRegistryProblem {
  type: string; title: string; status: number; instance: string; detail?: string;
}

export function entityNotFound(instance: string, entityType: string, id: string): XRegistryProblem {
  return { type: `${BASE}#entity_not_found`, title: `The ${entityType} "${id}" was not found`, status: 404, instance };
}

export function invalidParam(instance: string, param: string, detail?: string): XRegistryProblem {
  return { type: `${BASE}#invalid_data`, title: `Invalid parameter: ${param}`, status: 400, instance, ...(detail ? { detail } : {}) };
}
