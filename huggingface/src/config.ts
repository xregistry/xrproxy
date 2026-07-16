import { parseConfig, type ConfigSchema } from '@xregistry/registry-core';

export const hfConfigSchema = {
  HOST: { type: 'string', default: '0.0.0.0', minLength: 1 },
  PORT: { type: 'integer', default: 4300, min: 1, max: 65535 },
  HF_API_URL: { type: 'url', default: 'https://huggingface.co', protocols: ['http:', 'https:'] },
  UPSTREAM_TIMEOUT_MS: { type: 'integer', default: 10_000, min: 1 },
  UPSTREAM_OPERATION_TIMEOUT_MS: { type: 'integer', default: 30_000, min: 1 },
  UPSTREAM_MAX_ATTEMPTS: { type: 'integer', default: 3, min: 1, max: 10 },
  UPSTREAM_CONCURRENCY: { type: 'integer', default: 16, min: 1 },
  CACHE_DIR: { type: 'string', default: './cache', minLength: 1 },
  MUTABLE_CACHE_TTL_MS: { type: 'integer', default: 300_000, min: 0 },
  IMMUTABLE_CACHE_TTL_MS: { type: 'integer', default: 31_536_000_000, min: 0 },
} as const satisfies ConfigSchema;

export type HfConfig = ReturnType<typeof parseHfConfig>;

export function parseHfConfig(env: NodeJS.ProcessEnv = process.env): ReturnType<typeof parseConfig<typeof hfConfigSchema>> {
  return parseConfig(hfConfigSchema, env);
}
