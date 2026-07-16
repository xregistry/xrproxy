import { parseConfig } from '@xregistry/registry-core';

export const cratesConfigSchema = {
  HOST: { type: 'string', default: '0.0.0.0', minLength: 1 },
  PORT: { type: 'integer', default: 3700, min: 1, max: 65535 },
  UPSTREAM_URL: { type: 'url', default: 'https://crates.io', protocols: ['http:', 'https:'] },
  UPSTREAM_TIMEOUT_MS: { type: 'integer', default: 10_000, min: 1 },
  UPSTREAM_OPERATION_TIMEOUT_MS: { type: 'integer', default: 30_000, min: 1 },
  UPSTREAM_MAX_ATTEMPTS: { type: 'integer', default: 3, min: 1, max: 10 },
  UPSTREAM_CONCURRENCY: { type: 'integer', default: 16, min: 1 },
  CACHE_TTL_MS: { type: 'integer', default: 300_000, min: 0 },
  CACHE_NEGATIVE_TTL_MS: { type: 'integer', default: 30_000, min: 0 },
  CACHE_STALE_IF_ERROR_MS: { type: 'integer', default: 900_000, min: 0 },
  FIXTURE_MODE: { type: 'boolean', default: false },
  CACHE_DIR: { type: 'string', default: './cache', minLength: 1 },
} as const;

export type CratesConfig = ReturnType<typeof parseCratesConfig>;

export function parseCratesConfig(environment: NodeJS.ProcessEnv = process.env): ReturnType<typeof parseConfig<typeof cratesConfigSchema>> {
  return parseConfig(cratesConfigSchema, environment);
}
