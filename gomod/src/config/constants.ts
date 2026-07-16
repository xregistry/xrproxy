/**
 * Configuration for the Go Module xRegistry proxy.
 *
 * Uses schema-based config parsing from @xregistry/registry-core. The gomod
 * proxy needs two upstream URLs (GOPROXY and the Go index), so it defines its
 * own schema alongside the standard proxy schema.
 */

import { parseConfig, type ConfigSchema } from '@xregistry/registry-core';
import type { Request } from 'express';
import * as modelData from '../../model.json';

/**
 * Derive the base URL from the incoming request, respecting proxy headers.
 */
export function getBaseUrl(req: Request): string {
  const h = req.get('x-base-url') ?? process.env['BASE_URL'];
  if (h) return h;
  const proto = req.get('x-forwarded-proto') ?? req.protocol ?? 'https';
  const host = req.get('x-forwarded-host') ?? req.get('host') ?? 'localhost';
  return `${proto}://${host}`;
}

export const gomodConfigSchema = {
  HOST:             { type: 'string',  default: '0.0.0.0', minLength: 1 },
  PORT:             { type: 'integer', default: 3900, min: 1, max: 65535 },
  GOPROXY_URL:      { type: 'url',     default: 'https://proxy.golang.org', protocols: ['http:', 'https:'] },
  GO_INDEX_URL:     { type: 'url',     default: 'https://index.golang.org', protocols: ['http:', 'https:'] },
  CACHE_DIR:        { type: 'string',  default: './cache', minLength: 1 },
  INDEX_REFRESH_MS: { type: 'integer', default: 6 * 60 * 60 * 1000, min: 60_000 },
  INDEX_PAGE_LIMIT: { type: 'integer', default: 2000, min: 1 },
  INDEX_MAX_PAGES:  { type: 'integer', default: 50, min: 1 },
  API_KEY:          { type: 'string' },
} as const satisfies ConfigSchema;

export type GomodConfig = ReturnType<typeof loadConfig>;
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  return parseConfig(gomodConfigSchema, env);
}

export const REGISTRY_METADATA = {
  REGISTRY_ID:            'gomod-proxy',
  GROUP_TYPE:             'goregistries',
  GROUP_TYPE_SINGULAR:    'goregistry',
  GROUP_ID:               'pkg.go.dev',
  RESOURCE_TYPE:          'modules',
  RESOURCE_TYPE_SINGULAR: 'module',
  SPEC_VERSION:           '1.0-rc2',
} as const;

/** Pagination defaults for module and version collections. */
export const SERVER_CONFIG = {
  DEFAULT_PAGE_LIMIT: 50,
  /** Maximum modules to return in a single page */
  MAX_PAGE_LIMIT: 500,
} as const;

export const CATALOG_FILENAME = 'catalog.json';
export const MODEL_STRUCTURE = modelData;
