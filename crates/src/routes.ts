import type { Express, Request, Response, NextFunction } from 'express';
import { UpstreamError, isUpstreamError, TtlCache, FileSystemCacheStore, createCacheKey } from '@xregistry/registry-core';
import { CratesIoAdapter } from './adapter';
import { FixtureAdapter } from './fixtures';
import {
  mapCrate,
  mapGroup,
  mapRegistryRoot,
  mapVersion,
  buildBaseUrl,
  resolveDefaultVersion
} from './mapper';
import {
  DEFAULT_PAGE_SIZE,
  GROUP_TYPE,
  MAX_PAGE_SIZE,
  REGISTRY_ID,
  RESOURCE_TYPE
} from './model';

type Adapter = CratesIoAdapter | FixtureAdapter;
const MAX_FILTER_RESULTS = 1000;
const MAX_FILTER_UPSTREAM_PAGES = MAX_FILTER_RESULTS / MAX_PAGE_SIZE;

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

function parseOffset(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function parseNamePrefix(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^name=([^*]+)\*$/.exec(value.trim());
  return match?.[1];
}

function setPaginationLinks(
  req: Request,
  res: Response,
  offset: number,
  limit: number,
  hasPrevious: boolean,
  hasNext: boolean
): void {
  const links: string[] = [];
  const link = (targetOffset: number, relation: string): void => {
    const url = new URL(buildBaseUrl(req) + req.path);
    for (const [key, value] of Object.entries(req.query)) {
      if (typeof value === 'string' && key !== 'page' && key !== 'per_page') {
        url.searchParams.set(key, value);
      }
    }
    url.searchParams.set('offset', String(targetOffset));
    url.searchParams.set('limit', String(limit));
    links.push(`<${url.toString()}>; rel="${relation}"`);
  };
  if (hasPrevious) link(Math.max(0, offset - limit), 'prev');
  if (hasNext) link(offset + limit, 'next');
  if (links.length > 0) res.set('Link', links.join(', '));
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
      const limit = parseLimit(req.query['limit'] ?? req.query['per_page']);
      const requestedOffset = parseOffset(req.query['offset']);
      const page = requestedOffset === undefined
        ? parsePage(req.query['page'])
        : Math.floor(requestedOffset / limit) + 1;
      const pageOffset = requestedOffset === undefined ? 0 : requestedOffset % limit;
      const offset = requestedOffset ?? (page - 1) * limit;
      const namePrefix = parseNamePrefix(req.query['filter'] ?? req.query['$filter']);
      const query = namePrefix ?? (typeof req.query['q'] === 'string' ? req.query['q'] : undefined);
      const sort = typeof req.query['sort'] === 'string' ? req.query['sort'] : undefined;

      if (namePrefix !== undefined && offset >= MAX_FILTER_RESULTS) {
        res.status(400).json({
          error: 'invalid_offset',
          message: `Filtered crate offsets must be less than ${MAX_FILTER_RESULTS}`
        });
        return;
      }

      const cacheKey = createCacheKey('list', offset, limit, query ?? null, sort ?? null, namePrefix ?? null);
      const baseUrl = buildBaseUrl(req);

      const result = await cache.get(cacheKey, async context => {
        const loadPage = (targetPage: number) => {
          if (adapter instanceof FixtureAdapter) {
            return adapter.listCrates({
              page: targetPage,
              perPage: namePrefix === undefined ? limit : MAX_PAGE_SIZE,
              ...(query !== undefined ? { query } : {})
            });
          }
          return (adapter as CratesIoAdapter).listCrates({
            page: targetPage,
            perPage: namePrefix === undefined ? limit : MAX_PAGE_SIZE,
            ...(query !== undefined ? { query } : {}),
            ...(sort !== undefined ? { sort } : {}),
            ...(namePrefix === undefined && context.etag !== undefined ? { etag: context.etag } : {}),
            ...(namePrefix === undefined && context.lastModified !== undefined ? { lastModified: context.lastModified } : {})
          });
        };

        if (namePrefix !== undefined) {
          const matches = [];
          const normalizedPrefix = namePrefix.toLowerCase();
          for (let upstreamPage = 1; upstreamPage <= MAX_FILTER_UPSTREAM_PAGES; upstreamPage += 1) {
            const upstream = await loadPage(upstreamPage);
            if (upstream.kind !== 'value') {
              if (upstreamPage === 1) return upstream;
              break;
            }
            matches.push(...upstream.value.crates.filter(crate =>
              crate.name.toLowerCase().startsWith(normalizedPrefix)
            ));
            if (matches.length > offset + limit) break;
            const total = upstream.value.meta.total;
            if (upstream.value.crates.length < MAX_PAGE_SIZE ||
                (total !== undefined && upstreamPage * MAX_PAGE_SIZE >= total)) {
              break;
            }
          }
          return {
            kind: 'value' as const,
            value: {
              crates: matches.slice(offset, offset + limit + 1),
              meta: { total: matches.length }
            }
          };
        }

        const first = await loadPage(page);
        if (pageOffset === 0 || first.kind !== 'value') return first;
        const second = await loadPage(page + 1);
        if (second.kind !== 'value') return first;
        return {
          kind: 'value' as const,
          value: {
            crates: [...first.value.crates, ...second.value.crates].slice(pageOffset, pageOffset + limit),
            meta: first.value.meta
          }
        };
      });

      if (result.kind === 'not-found') {
        res.json({});
        return;
      }

      const resultCrates = result.value?.crates ?? [];
      const hasNext = namePrefix === undefined
        ? offset + limit < (result.value?.meta.total ?? offset + resultCrates.length)
        : resultCrates.length > limit;
      const hasPrevious = namePrefix === undefined
        ? offset > 0
        : offset > 0 && (result.value?.meta.total ?? 0) > 0;
      const crates = resultCrates.slice(0, limit);
      const mapped: Record<string, unknown> = {};
      for (const crate of crates) {
        mapped[crate.name] = mapCrate(crate, baseUrl);
      }

      setPaginationLinks(req, res, offset, limit, hasPrevious, hasNext);
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
      const limit = parseLimit(req.query['limit'] ?? req.query['per_page']);
      const requestedOffset = parseOffset(req.query['offset']);
      const page = requestedOffset === undefined ? parsePage(req.query['page']) : 1;
      const offset = requestedOffset ?? (page - 1) * limit;

      const baseUrl = buildBaseUrl(req);
      const crateCacheKey = createCacheKey('crate', crateId);

      const crateResult = await cache.get(crateCacheKey, async context => {
        if (adapter instanceof FixtureAdapter) {
          return adapter.getCrate(crateId);
        }
        return (adapter as CratesIoAdapter).getCrate(crateId, {
          ...(context.etag !== undefined ? { etag: context.etag } : {}),
          ...(context.lastModified !== undefined ? { lastModified: context.lastModified } : {})
        });
      });

      if (crateResult.kind === 'not-found') {
        next(notFound(crateId, 'Crate'));
        return;
      }

      const defaultVersion = resolveDefaultVersion(crateResult.value!.crate);
      const allVersions = crateResult.value?.versions ?? [];
      const versions = allVersions.slice(offset, offset + limit);
      const mapped: Record<string, unknown> = {};
      for (const version of versions) {
        mapped[version.num] = mapVersion(version, defaultVersion, baseUrl);
      }

      setPaginationLinks(req, res, offset, limit, offset > 0 && allVersions.length > 0, offset + limit < allVersions.length);
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

      res.json(mapVersion(version, resolveDefaultVersion(crateData.crate), baseUrl));
    } catch (error) {
      next(error);
    }
  });

  // Error handler must come last
  app.use(handleError);
}
