import type { Express, Request, Response, NextFunction } from 'express';
import { UpstreamError, isUpstreamError, TtlCache, FileSystemCacheStore, createCacheKey } from '@xregistry/registry-core';
import { CratesIoAdapter } from './adapter';
import { FixtureAdapter } from './fixtures';
import {
  mapCrate,
  mapGroup,
  mapRegistryRoot,
  mapVersion,
  buildBaseUrl
} from './mapper';
import {
  DEFAULT_PAGE_SIZE,
  GROUP_TYPE,
  MAX_PAGE_SIZE,
  REGISTRY_ID,
  RESOURCE_TYPE
} from './model';

type Adapter = CratesIoAdapter | FixtureAdapter;

function parsePage(value: unknown): number {
  if (typeof value !== 'string') return 1;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

function parseLimit(value: unknown): number {
  if (typeof value !== 'string') return DEFAULT_PAGE_SIZE;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(n, MAX_PAGE_SIZE);
}

function handleError(error: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (isUpstreamError(error)) {
    const upstreamError = error as UpstreamError;
    if (upstreamError.code === 'not_found') {
      res.status(404).json({ error: 'not_found', message: upstreamError.message });
      return;
    }
    if (upstreamError.code === 'rate_limited') {
      const headers: Record<string, string> = {};
      if (upstreamError.retryAfterMs !== undefined) {
        headers['Retry-After'] = String(Math.ceil(upstreamError.retryAfterMs / 1000));
      }
      res.set(headers).status(429).json({ error: 'rate_limited', message: upstreamError.message });
      return;
    }
    res.status(502).json({ error: upstreamError.code, message: upstreamError.message });
    return;
  }
  res.status(500).json({ error: 'internal_server_error' });
}

function notFound(id: string, kind: string): UpstreamError {
  return new UpstreamError({ code: 'not_found', message: `${kind} not found: ${id}` });
}

export function registerRoutes(app: Express, adapter: Adapter, cacheConfig: {
  readonly ttlMs: number;
  readonly negativeTtlMs: number;
  readonly staleIfErrorMs: number;
  readonly cacheDir: string;
}): void {
  const store = new FileSystemCacheStore(cacheConfig.cacheDir);
  const cache = new TtlCache(store, {
    ttlMs: cacheConfig.ttlMs,
    negativeTtlMs: cacheConfig.negativeTtlMs,
    staleIfErrorMs: cacheConfig.staleIfErrorMs
  });

  /** GET / — registry root */
  app.get('/', (_req: Request, res: Response) => {
    const baseUrl = buildBaseUrl(_req);
    res.json(mapRegistryRoot(baseUrl, `${baseUrl}/${GROUP_TYPE}`));
  });

  /** GET /rustregistries — collection of groups */
  app.get(`/${GROUP_TYPE}`, (req: Request, res: Response) => {
    const baseUrl = buildBaseUrl(req);
    const group = mapGroup(baseUrl);
    res.json({ [REGISTRY_ID]: group });
  });

  /** GET /rustregistries/:registryId — single group */
  app.get(`/${GROUP_TYPE}/:registryId`, (req: Request, res: Response, next: NextFunction): void => {
    const registryId = String(req.params['registryId'] ?? '');
    if (registryId !== REGISTRY_ID) {
      next(notFound(registryId, 'Registry'));
      return;
    }
    const baseUrl = buildBaseUrl(req);
    res.json(mapGroup(baseUrl));
  });

  /** GET /rustregistries/:registryId/crates — list crates (bounded pagination) */
  app.get(`/${GROUP_TYPE}/:registryId/${RESOURCE_TYPE}`, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const registryId = String(req.params['registryId'] ?? '');
    if (registryId !== REGISTRY_ID) {
      next(notFound(registryId, 'Registry'));
      return;
    }
    try {
      const page = parsePage(req.query['page']);
      const limit = parseLimit(req.query['limit'] ?? req.query['per_page']);
      const query = typeof req.query['q'] === 'string' ? req.query['q'] : undefined;
      const sort = typeof req.query['sort'] === 'string' ? req.query['sort'] : undefined;

      const cacheKey = createCacheKey('list', page, limit, query ?? null, sort ?? null);
      const baseUrl = buildBaseUrl(req);

      const result = await cache.get(cacheKey, async context => {
        if (adapter instanceof FixtureAdapter) {
          return adapter.listCrates({
            page,
            perPage: limit,
            ...(query !== undefined ? { query } : {})
          });
        }
        return (adapter as CratesIoAdapter).listCrates({
          page,
          perPage: limit,
          ...(query !== undefined ? { query } : {}),
          ...(sort !== undefined ? { sort } : {}),
          ...(context.etag !== undefined ? { etag: context.etag } : {}),
          ...(context.lastModified !== undefined ? { lastModified: context.lastModified } : {})
        });
      });

      if (result.kind === 'not-found') {
        res.json({});
        return;
      }

      const crates = result.value?.crates ?? [];
      const mapped: Record<string, unknown> = {};
      for (const crate of crates) {
        mapped[crate.name] = mapCrate(crate, baseUrl);
      }

      res.json(mapped);
    } catch (error) {
      next(error);
    }
  });

  /** GET /rustregistries/:registryId/crates/:crateId — single crate */
  app.get(`/${GROUP_TYPE}/:registryId/${RESOURCE_TYPE}/:crateId`, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const registryId = String(req.params['registryId'] ?? '');
    const crateId = String(req.params['crateId'] ?? '');
    if (registryId !== REGISTRY_ID) {
      next(notFound(registryId, 'Registry'));
      return;
    }
    try {
      const cacheKey = createCacheKey('crate', crateId);
      const baseUrl = buildBaseUrl(req);

      const result = await cache.get(cacheKey, async context => {
        if (adapter instanceof FixtureAdapter) {
          return adapter.getCrate(crateId);
        }
        return (adapter as CratesIoAdapter).getCrate(crateId, {
          ...(context.etag !== undefined ? { etag: context.etag } : {}),
          ...(context.lastModified !== undefined ? { lastModified: context.lastModified } : {})
        });
      });

      if (result.kind === 'not-found') {
        next(notFound(crateId, 'Crate'));
        return;
      }

      res.json(mapCrate(result.value!.crate, baseUrl));
    } catch (error) {
      next(error);
    }
  });

  /** GET /rustregistries/:registryId/crates/:crateId/versions — list versions (immutable) */
  app.get(`/${GROUP_TYPE}/:registryId/${RESOURCE_TYPE}/:crateId/versions`, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const registryId = String(req.params['registryId'] ?? '');
    const crateId = String(req.params['crateId'] ?? '');
    if (registryId !== REGISTRY_ID) {
      next(notFound(registryId, 'Registry'));
      return;
    }
    try {
      const page = parsePage(req.query['page']);
      const limit = parseLimit(req.query['limit'] ?? req.query['per_page']);

      const cacheKey = createCacheKey('versions', crateId, page, limit);
      const baseUrl = buildBaseUrl(req);
      const crateCacheKey = createCacheKey('crate', crateId);

      const [versionsResult, crateResult] = await Promise.all([
        cache.get(cacheKey, async context => {
          if (adapter instanceof FixtureAdapter) {
            return adapter.getCrateVersions(crateId);
          }
          return (adapter as CratesIoAdapter).getCrateVersions(crateId, {
            page,
            perPage: limit,
            ...(context.etag !== undefined ? { etag: context.etag } : {}),
            ...(context.lastModified !== undefined ? { lastModified: context.lastModified } : {})
          });
        }),
        cache.get(crateCacheKey, async context => {
          if (adapter instanceof FixtureAdapter) {
            return adapter.getCrate(crateId);
          }
          return (adapter as CratesIoAdapter).getCrate(crateId, {
            ...(context.etag !== undefined ? { etag: context.etag } : {}),
            ...(context.lastModified !== undefined ? { lastModified: context.lastModified } : {})
          });
        })
      ]);

      if (versionsResult.kind === 'not-found') {
        next(notFound(crateId, 'Crate'));
        return;
      }

      const maxStableVersion = crateResult.kind === 'value'
        ? (crateResult.value?.crate.max_stable_version ?? null)
        : null;

      const versions = versionsResult.value?.versions ?? [];
      const mapped: Record<string, unknown> = {};
      for (const version of versions) {
        mapped[version.num] = mapVersion(version, maxStableVersion, baseUrl);
      }

      res.json(mapped);
    } catch (error) {
      next(error);
    }
  });

  /** GET /rustregistries/:registryId/crates/:crateId/versions/:versionId — single version (immutable) */
  app.get(`/${GROUP_TYPE}/:registryId/${RESOURCE_TYPE}/:crateId/versions/:versionId`, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const registryId = String(req.params['registryId'] ?? '');
    const crateId = String(req.params['crateId'] ?? '');
    const versionId = String(req.params['versionId'] ?? '');
    if (registryId !== REGISTRY_ID) {
      next(notFound(registryId, 'Registry'));
      return;
    }
    try {
      const cacheKey = createCacheKey('crate', crateId);
      const baseUrl = buildBaseUrl(req);

      const result = await cache.get(cacheKey, async context => {
        if (adapter instanceof FixtureAdapter) {
          return adapter.getCrate(crateId);
        }
        return (adapter as CratesIoAdapter).getCrate(crateId, {
          ...(context.etag !== undefined ? { etag: context.etag } : {}),
          ...(context.lastModified !== undefined ? { lastModified: context.lastModified } : {})
        });
      });

      if (result.kind === 'not-found') {
        next(notFound(crateId, 'Crate'));
        return;
      }

      const crateData = result.value!;
      const version = crateData.versions.find(v => v.num === versionId);
      if (!version) {
        next(notFound(versionId, 'Version'));
        return;
      }

      res.json(mapVersion(version, crateData.crate.max_stable_version, baseUrl));
    } catch (error) {
      next(error);
    }
  });

  // Error handler must come last
  app.use(handleError);
}
