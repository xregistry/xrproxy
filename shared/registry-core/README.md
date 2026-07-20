# `@xregistry/registry-core`

Reusable TypeScript runtime primitives for new xRegistry registry proxies. The package is registry-neutral and does not change existing services.

## Install from this repository

```json
{
  "dependencies": {
    "@xregistry/registry-core": "file:../shared/registry-core"
  }
}
```

The package `prepare` lifecycle builds TypeScript automatically when npm installs the local `file:` dependency. Generated `dist` files are not committed.

## Example

```ts
import {
  createCacheKey,
  createRegistryCapabilities,
  createRegistryApp,
  HttpUpstreamClient,
  MemoryCacheStore,
  parseProxyConfig,
  TtlCache
} from '@xregistry/registry-core';

const config = parseProxyConfig();
const http = new HttpUpstreamClient({
  timeoutMs: config.UPSTREAM_TIMEOUT_MS,
  operationTimeoutMs: config.UPSTREAM_OPERATION_TIMEOUT_MS,
  maxAttempts: config.UPSTREAM_MAX_ATTEMPTS,
  concurrency: config.UPSTREAM_CONCURRENCY
});
const cache = new TtlCache(new MemoryCacheStore(), {
  ttlMs: config.CACHE_TTL_MS,
  negativeTtlMs: config.CACHE_NEGATIVE_TTL_MS,
  staleIfErrorMs: config.CACHE_STALE_IF_ERROR_MS
});

const key = createCacheKey('resource', 'identity');
const result = await cache.get(key, async conditional => {
  const response = await http.getJson(`${config.UPSTREAM_URL}resource`, { conditional });
  return response.status === 304
    ? { kind: 'not-modified', etag: response.etag, lastModified: response.lastModified }
    : { kind: 'value', value: response.value, etag: response.etag, lastModified: response.lastModified };
});

const app = createRegistryApp({
  model: { groups: {} },
  capabilities: createRegistryCapabilities({ flags: ["filter"], versionmodes: ["manual"] }),
  configure(expressApp) {
    expressApp.get('/resources/:id', (_request, response) => response.json(result));
  }
});
```

## Modules

- `HttpUpstreamClient`: cancellable concurrency and retry waits, per-attempt timeout, a total operation deadline covering queueing/retries/backoff, jittered idempotent retries, conditional requests, and normalized upstream errors.
- `TtlCache`: positive/negative TTLs, immutable values, stale-if-error, validator refresh on `304`, and per-key single-flight loading.
- `MemoryCacheStore` / `FileSystemCacheStore`: pluggable cache storage using bounded Base64URL-safe keys. Filesystem values must be JSON-serializable.
- `parseConfig` / `parseProxyConfig`: typed environment parsing with aggregated validation errors.
- `createRegistryCapabilities`: emits every known xRegistry 1.0-rc2 capability with the required types and fixed rc2 schema/spec-version entries; callers opt in only to implemented APIs and flags.
- `createRegistryApp` / `listenWithGracefulShutdown`: standard health, readiness, capabilities, `/modelsource` (the sparse input), and `/model` (the fully expanded rc2 model) endpoints.
- `expandRegistryModel`: adds the specification-defined Registry, Group, Version, Resource, and Meta attributes without mutating the model source.
- `startFixtureServer`: deterministic local HTTP fixtures with response sequences, validator handling, and request capture.
