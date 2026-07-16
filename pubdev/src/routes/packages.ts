/**
 * Package and version routes
 * Implements /dartregistries/pub.dev/packages/* endpoints
 */

import { type NextFunction, type Request, type Response, Router } from 'express';
import { UpstreamError } from '@xregistry/registry-core';
import { EntityStateManager } from '../../../shared/entity-state-manager';
import { getBaseUrl, REGISTRY_METADATA } from '../config/constants';
import { PackageService } from '../services/package-service';
import { SearchService } from '../services/search-service';

const { GROUP_TYPE, GROUP_ID, RESOURCE_TYPE } = REGISTRY_METADATA;
const BASE = `/${GROUP_TYPE}/${GROUP_ID}/${RESOURCE_TYPE}`;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

function wrap(fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) =>
    fn(req, res, next).catch(next);
}

function notFound(instance: string, kind: string, id: string): never {
  throw new UpstreamError({
    code: 'not_found',
    status: 404,
    message: `The ${kind} (${id}) was not found`,
    details: { instance },
  });
}

function badRequest(instance: string, detail: string): never {
  throw new UpstreamError({
    code: 'invalid_response',
    status: 400,
    message: detail,
    details: { instance },
  });
}

export function createPackageRoutes(
  packageService: PackageService,
  searchService: SearchService,
  entityState: EntityStateManager,
): Router {
  const router = Router();

  // ── Package collection ──────────────────────────────────────────────────
  router.get(BASE, wrap(async (req, res) => {
    const baseUrl = getBaseUrl(req);
    const limit  = req.query['limit']  ? parseInt(req.query['limit']  as string, 10) : DEFAULT_LIMIT;
    const offset = req.query['offset'] ? parseInt(req.query['offset'] as string, 10) : 0;
    const filter = req.query['filter'] as string | undefined;
    const sort   = req.query['sort']   as string | undefined;

    if (!Number.isFinite(limit) || limit <= 0 || limit > MAX_LIMIT)
      badRequest(req.originalUrl, `limit must be 1–${MAX_LIMIT}`);
    if (!Number.isFinite(offset) || offset < 0)
      badRequest(req.originalUrl, 'offset must be a non-negative integer');

    let names = searchService.getAll();

    if (filter) {
      const nameMatch = filter.match(/^name=(.+)$/i);
      if (!nameMatch) {
        names = [];
      } else {
        const pattern = nameMatch[1]!;
        if (pattern.includes('*') || pattern.includes('?')) {
          const re = new RegExp(
            '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$',
            'i',
          );
          names = names.filter(n => re.test(n));
        } else {
          names = names.filter(n => n.toLowerCase().includes(pattern.toLowerCase()));
        }
      }
    }

    if (sort) {
      const desc = sort.toLowerCase().endsWith('=desc');
      names = [...names].sort((a, b) => desc ? b.localeCompare(a) : a.localeCompare(b));
    }

    const total = names.length;
    const page  = names.slice(offset, offset + limit);
    const base  = `${baseUrl}${BASE}`;

    const packages: Record<string, unknown> = {};
    for (const name of page) {
      const rPath = `${BASE}/${name}`;
      packages[name] = {
        packageid:   name,
        xid:         rPath,
        name,
        epoch:       entityState.getEpoch(rPath),
        createdat:   entityState.getCreatedAt(rPath),
        modifiedat:  entityState.getModifiedAt(rPath),
        self:        `${base}/${name}`,
        versionsurl: `${base}/${name}/versions`,
        metaurl:     `${base}/${name}/meta`,
      };
    }

    if (total > 0) {
      const links: string[] = [];
      const qp = (): URLSearchParams => {
        const record: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.query)) {
          if (typeof v === 'string') record[k] = v;
          else if (Array.isArray(v) && typeof v[0] === 'string') record[k] = v[0] as string;
        }
        return new URLSearchParams(record);
      };

      const set = (o: number): string => {
        const p = qp(); p.set('offset', String(o)); p.set('limit', String(limit));
        return `${baseUrl}${req.path}?${p.toString()}`;
      };

      if (offset > 0) links.push(`<${set(0)}>; rel="first"`);
      if (offset > 0) links.push(`<${set(Math.max(0, offset - limit))}>; rel="prev"`);
      if (offset + limit < total) links.push(`<${set(offset + limit)}>; rel="next"`);
      if (offset + limit < total) links.push(`<${set(Math.floor((total - 1) / limit) * limit)}>; rel="last"`);
      if (searchService.isAuthoritative()) links.push(`count="${total}"`);
      links.push(`per-page="${limit}"`);
      res.set('Link', links.join(', '));
    }

    res.json(packages);
  }));

  // ── Package metadata ────────────────────────────────────────────────────
  router.get(`${BASE}/:packageName`, wrap(async (req, res) => {
    const name    = req.params['packageName'] as string;
    const baseUrl = getBaseUrl(req);
    const ok = await searchService.exists(name);
    if (!ok) notFound(req.originalUrl, 'package', name);
    res.json(await packageService.getPackageMetadata(name, baseUrl));
  }));

  // ── Package meta ────────────────────────────────────────────────────────
  router.get(`${BASE}/:packageName/meta`, wrap(async (req, res) => {
    const name    = req.params['packageName'] as string;
    const baseUrl = getBaseUrl(req);
    const ok = await searchService.exists(name);
    if (!ok) notFound(req.originalUrl, 'package', name);
    res.json(await packageService.getPackageMeta(name, baseUrl));
  }));

  // ── Versions collection ─────────────────────────────────────────────────
  router.get(`${BASE}/:packageName/versions`, wrap(async (req, res) => {
    const name    = req.params['packageName'] as string;
    const baseUrl = getBaseUrl(req);
    const ok = await searchService.exists(name);
    if (!ok) notFound(req.originalUrl, 'package', name);
    res.json(await packageService.getPackageVersions(name, baseUrl));
  }));

  // ── Specific version ────────────────────────────────────────────────────
  router.get(`${BASE}/:packageName/versions/:versionId`, wrap(async (req, res) => {
    const name      = req.params['packageName'] as string;
    const versionId = req.params['versionId']   as string;
    const baseUrl   = getBaseUrl(req);
    const ok = await searchService.exists(name);
    if (!ok) notFound(req.originalUrl, 'package', name);
    res.json(await packageService.getVersionDetails(name, versionId, baseUrl));
  }));

  return router;
}
