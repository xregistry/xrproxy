/**
 * Configuration constants for pub.dev xRegistry server
 */

import { type Request } from 'express';
import { parseConfig, proxyConfigSchema, type ParsedConfig } from '@xregistry/registry-core';
import model from '../../model.json';

/**
 * Extended config schema with pub.dev-specific fields
 */
export const pubdevConfigSchema = {
  ...proxyConfigSchema,
  PORT:         { type: 'integer', default: 4200,    min: 1, max: 65535 },
  UPSTREAM_URL: { type: 'url',     default: 'https://pub.dev', protocols: ['https:', 'http:'] },
} as const;

export type PubDevConfig = ParsedConfig<typeof pubdevConfigSchema>;

export function parsePubDevConfig(env: NodeJS.ProcessEnv = process.env): PubDevConfig {
  return parseConfig(pubdevConfigSchema, env);
}

/**
 * Get the actual base URL from a request
 */
export function getBaseUrl(req: Request): string {
  const baseUrlHeader = req.get('x-base-url');
  if (baseUrlHeader) return baseUrlHeader;
  if (process.env['BASE_URL']) return process.env['BASE_URL'];
  const protocol = req.get('x-forwarded-proto') ?? req.protocol ?? 'https';
  const host = req.get('x-forwarded-host') ?? req.get('host');
  if (host) return `${protocol}://${host}`;
  return `${req.protocol}://${req.get('host')}`;
}

/**
 * xRegistry metadata
 */
export const REGISTRY_METADATA = {
  REGISTRY_ID:          'pubdev-wrapper',
  GROUP_TYPE:           'dartregistries',
  GROUP_TYPE_SINGULAR:  'dartregistry',
  GROUP_ID:             'pub.dev',
  RESOURCE_TYPE:        'packages',
  RESOURCE_TYPE_SINGULAR: 'package',
  SPEC_VERSION:         '1.0-rc2',
} as const;

/**
 * pub.dev API path constants (relative to UPSTREAM_URL)
 */
export const PUBDEV_PATHS = {
  PACKAGE_NAMES: '/api/package-names',
  PACKAGE:       (name: string) => `/api/packages/${encodeURIComponent(name)}`,
  VERSION:       (name: string, version: string) =>
    `/api/packages/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`,
  SCORE:         (name: string) => `/api/packages/${encodeURIComponent(name)}/score`,
  PUBLISHER:     (name: string) => `/api/packages/${encodeURIComponent(name)}/publisher`,
} as const;

/**
 * Fallback package names — deterministic, no live API required.
 */
export const FALLBACK_PACKAGES: readonly string[] = [
  'bloc', 'collection', 'dio', 'equatable', 'flutter_bloc',
  'flutter_riverpod', 'fpdart', 'freezed', 'get', 'http',
  'intl', 'json_annotation', 'json_serializable', 'meta', 'mockito',
  'path', 'path_provider', 'provider', 'riverpod', 'rxdart',
  'shared_preferences', 'shelf', 'shelf_router', 'test', 'uuid',
  'very_good_analysis', 'yaml',
];

/**
 * Model (exported for createRegistryApp)
 */
export const MODEL = model;

/**
 * Capabilities
 */
export const CAPABILITIES = {
  apis:       ['/capabilities', '/model', '/export'],
  filter:     true,
  sort:       true,
  doc:        false,
  mutable:    false,
  pagination: true,
} as const;
