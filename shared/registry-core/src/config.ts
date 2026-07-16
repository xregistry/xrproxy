export type ConfigField =
  | { readonly type: 'string'; readonly required?: boolean; readonly default?: string; readonly minLength?: number }
  | { readonly type: 'integer'; readonly required?: boolean; readonly default?: number; readonly min?: number; readonly max?: number }
  | { readonly type: 'number'; readonly required?: boolean; readonly default?: number; readonly min?: number; readonly max?: number }
  | { readonly type: 'boolean'; readonly required?: boolean; readonly default?: boolean }
  | { readonly type: 'url'; readonly required?: boolean; readonly default?: string; readonly protocols?: readonly string[] }
  | { readonly type: 'enum'; readonly required?: boolean; readonly default?: string; readonly values: readonly string[] };

export type ConfigSchema = Readonly<Record<string, ConfigField>>;

type ConfigValue<T extends ConfigField> =
  T['type'] extends 'integer' | 'number' ? number :
    T['type'] extends 'boolean' ? boolean :
      string;

export type ParsedConfig<T extends ConfigSchema> = {
  readonly [K in keyof T as T[K] extends { readonly required: true } | { readonly default: unknown }
    ? K
    : never]: ConfigValue<T[K]>;
} & {
  readonly [K in keyof T as T[K] extends { readonly required: true } | { readonly default: unknown }
    ? never
    : K]?: ConfigValue<T[K]>;
};

export class ConfigurationError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid configuration:\n- ${problems.join('\n- ')}`);
    this.name = 'ConfigurationError';
  }
}

export function parseConfig<T extends ConfigSchema>(
  schema: T,
  environment: NodeJS.ProcessEnv = process.env
): ParsedConfig<T> {
  const result: Record<string, unknown> = {};
  const problems: string[] = [];

  for (const [name, field] of Object.entries(schema)) {
    const raw = environment[name];
    const value = raw === undefined || raw === '' ? field.default : raw;
    if (value === undefined) {
      if (field.required) {
        problems.push(`${name} is required`);
      }
      continue;
    }
    try {
      result[name] = parseField(name, value, field);
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (problems.length > 0) {
    throw new ConfigurationError(problems);
  }
  return result as ParsedConfig<T>;
}

function parseField(name: string, value: string | number | boolean, field: ConfigField): unknown {
  switch (field.type) {
    case 'string': {
      const parsed = String(value);
      if (parsed.length < (field.minLength ?? 0)) {
        throw new Error(`${name} must contain at least ${field.minLength} characters`);
      }
      return parsed;
    }
    case 'integer':
    case 'number': {
      const parsed = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(parsed) || (field.type === 'integer' && !Number.isInteger(parsed))) {
        throw new Error(`${name} must be ${field.type === 'integer' ? 'an integer' : 'a number'}`);
      }
      if (field.min !== undefined && parsed < field.min) {
        throw new Error(`${name} must be at least ${field.min}`);
      }
      if (field.max !== undefined && parsed > field.max) {
        throw new Error(`${name} must be at most ${field.max}`);
      }
      return parsed;
    }
    case 'boolean': {
      if (typeof value === 'boolean') {
        return value;
      }
      if (value === 'true' || value === '1') {
        return true;
      }
      if (value === 'false' || value === '0') {
        return false;
      }
      throw new Error(`${name} must be true, false, 1, or 0`);
    }
    case 'url': {
      const parsed = new URL(String(value));
      if (field.protocols && !field.protocols.includes(parsed.protocol)) {
        throw new Error(`${name} must use one of: ${field.protocols.join(', ')}`);
      }
      return parsed.toString();
    }
    case 'enum': {
      const parsed = String(value);
      if (!field.values.includes(parsed)) {
        throw new Error(`${name} must be one of: ${field.values.join(', ')}`);
      }
      return parsed;
    }
  }
}

export const proxyConfigSchema = {
  HOST: { type: 'string', default: '0.0.0.0', minLength: 1 },
  PORT: { type: 'integer', default: 3000, min: 1, max: 65535 },
  UPSTREAM_URL: { type: 'url', required: true, protocols: ['http:', 'https:'] },
  UPSTREAM_TIMEOUT_MS: { type: 'integer', default: 10_000, min: 1 },
  UPSTREAM_OPERATION_TIMEOUT_MS: { type: 'integer', default: 30_000, min: 1 },
  UPSTREAM_MAX_ATTEMPTS: { type: 'integer', default: 3, min: 1, max: 10 },
  UPSTREAM_CONCURRENCY: { type: 'integer', default: 16, min: 1 },
  CACHE_TTL_MS: { type: 'integer', default: 300_000, min: 0 },
  CACHE_NEGATIVE_TTL_MS: { type: 'integer', default: 30_000, min: 0 },
  CACHE_STALE_IF_ERROR_MS: { type: 'integer', default: 900_000, min: 0 }
} as const satisfies ConfigSchema;

export type ProxyConfig = ParsedConfig<typeof proxyConfigSchema>;

export function parseProxyConfig(environment: NodeJS.ProcessEnv = process.env): ProxyConfig {
  return parseConfig(proxyConfigSchema, environment);
}
