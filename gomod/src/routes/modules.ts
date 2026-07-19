/**
 * Module and version routes.
 *
 * Go module paths contain slashes (e.g. github.com/pkg/errors).
 * We use a sub-router mounted via router.use() at the modules base path
 * and parse req.path directly, avoiding Express path-to-regexp wildcard
 * syntax issues in Express 5.
 */

import { NextFunction, Request, Response, Router } from 'express';
import { getBaseUrl, REGISTRY_METADATA, SERVER_CONFIG } from '../config/constants';
import { CheckpointService } from '../services/checkpoint-service';
import { ModuleService } from '../services/module-service';
import { encodeModulePathForUrl, unescapePath } from '../utils/path-escaping';
import { entityNotFound } from '../utils/xregistry-errors';

const { GROUP_TYPE, GROUP_ID, RESOURCE_TYPE } = REGISTRY_METADATA;

function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) {
    return (req: Request, res: Response, next: NextFunction): void => {
        fn(req, res, next).catch(next);
    };
}

export function createModuleRoutes(
    moduleService: ModuleService,
    checkpointService: CheckpointService
): Router {
    const router = Router();
    const collectionPath = `/${GROUP_TYPE}/${GROUP_ID}/${RESOURCE_TYPE}`;

    // -------------------------------------------------------------------------
    // Module collection  GET /goregistries/pkg.go.dev/modules
    // -------------------------------------------------------------------------
    router.get(
        collectionPath,
        asyncHandler(async (req: Request, res: Response): Promise<void> => {
            const baseUrl = getBaseUrl(req);
            const limit = Math.min(
                parseInt(String(req.query['limit'] ?? SERVER_CONFIG.DEFAULT_PAGE_LIMIT), 10),
                SERVER_CONFIG.MAX_PAGE_LIMIT
            );
            const offset = Math.max(
                parseInt(String(req.query['offset'] ?? '0'), 10),
                0
            );
            const filterParam = req.query['filter'] as string | undefined;

            if (isNaN(limit) || limit <= 0) {
                res.status(400).json({ type: 'about:blank', title: 'limit must be > 0', status: 400, instance: req.originalUrl });
                return;
            }

            let paths: string[];
            let totalKnown: number;

            if (filterParam) {
                const nameMatch = filterParam.match(/name=(.+)/i);
                const pattern = nameMatch ? nameMatch[1] : filterParam;
                const result = checkpointService.filterModulePaths(pattern, offset, limit);
                paths = result.paths;
                totalKnown = result.totalMatched;
            } else {
                const result = checkpointService.listModulePaths(offset, limit);
                paths = result.paths;
                totalKnown = result.totalKnown;
            }

            const modules: Record<string, unknown> = {};
            for (const p of paths) {
                const catalogEntry = checkpointService.getModule(p);
                const xp = `/${GROUP_TYPE}/${GROUP_ID}/${RESOURCE_TYPE}/${p}`;
                const selfUrl = `${baseUrl}/${GROUP_TYPE}/${GROUP_ID}/${RESOURCE_TYPE}/${encodeModulePathForUrl(p)}`;
                modules[p] = {
                    moduleid: p,
                    versionid: catalogEntry?.latestVersion,
                    isdefault: true,
                    xid: xp,
                    name: p,
                    self: selfUrl,
                    versionsurl: `${selfUrl}/versions`,
                    versionscount: catalogEntry ? catalogEntry.versions.length : undefined,
                    latest_version: catalogEntry ? catalogEntry.latestVersion : undefined,
                };
            }

            const collectionUrl = `${baseUrl}${collectionPath}`;
            const nextOffset = offset + paths.length;
            const hasMore = nextOffset < totalKnown;

            res.setHeader('X-Total-Count', String(totalKnown));
            if (hasMore) {
                const nextQuery = new URLSearchParams({
                    offset: String(nextOffset),
                    limit: String(limit),
                });
                if (filterParam !== undefined) {
                    nextQuery.set('filter', filterParam);
                }
                res.setHeader(
                    'Link',
                    `<${collectionUrl}?${nextQuery.toString()}>; rel="next"`
                );
            }

            res.json(modules);
        })
    );

    // -------------------------------------------------------------------------
    // Sub-paths under /modules/ handled via router.use() to support slashy
    // module paths like github.com/pkg/errors without path-to-regexp issues.
    // Within the handler req.path is relative to the mount point.
    // -------------------------------------------------------------------------
    router.use(
        `${collectionPath}/`,
        asyncHandler(async (req: Request, res: Response, next: NextFunction): Promise<void> => {
            if (req.method !== 'GET') { next(); return; }

            const relPath = decodeURIComponent(req.path.replace(/^\//, ''));
            if (!relPath) { next(); return; }

            // Anchored dispatch: treat `/versions` as a delimiter only when it
            // sits at a definite position — followed by end-of-string (the
            // versions collection) or by `/<version>` (a single version). This
            // prevents mis-parsing a module whose own path contains a segment
            // that merely looks like `versions`.
            //
            //   <modulePath>/versions/<version>   version has no slashes
            const verMatch = relPath.match(/^(.+?)\/versions\/([^/]+)$/);
            //   <modulePath>/versions             exact trailing sentinel
            const versionsMatch = relPath.match(/^(.+?)\/versions$/);
            //   Does the path contain a `/versions` sentinel at all?
            const hasVersionsSentinel = /\/versions(?:\/|$)/.test(relPath);

            // Match: <modulePath>/versions/<version>
            if (verMatch) {
                const modulePath = unescapePath(verMatch[1]);
                const version = verMatch[2];
                const record = await moduleService.getVersion(req, modulePath, version);
                if (!record) {
                    res.status(404).json(entityNotFound(req.originalUrl, 'version', `${modulePath}@${version}`));
                    return;
                }
                res.json(record);
                return;
            }

            // Match: <modulePath>/versions
            if (versionsMatch) {
                const baseUrl = getBaseUrl(req);
                const modulePath = unescapePath(versionsMatch[1]);
                const limit = Math.min(
                    parseInt(String(req.query['limit'] ?? SERVER_CONFIG.DEFAULT_PAGE_LIMIT), 10),
                    SERVER_CONFIG.MAX_PAGE_LIMIT
                );
                const offset = Math.max(parseInt(String(req.query['offset'] ?? '0'), 10), 0);

                const result = await moduleService.listVersions(req, modulePath, offset, limit);
                if (!result) {
                    res.status(404).json(entityNotFound(req.originalUrl, 'module', modulePath));
                    return;
                }

                const { versions, totalCount } = result;
                const versionsUrl = `${baseUrl}/${GROUP_TYPE}/${GROUP_ID}/${RESOURCE_TYPE}/${encodeModulePathForUrl(modulePath)}/versions`;
                const nextOffset = offset + versions.length;
                const hasMore = nextOffset < totalCount;

                res.setHeader('X-Total-Count', String(totalCount));
                if (hasMore) {
                    res.setHeader('Link', `<${versionsUrl}?offset=${nextOffset}&limit=${limit}>; rel="next"`);
                }

                const body: Record<string, unknown> = {};
                for (const v of versions) {
                    body[v.versionid] = v;
                }
                res.json(body);
                return;
            }

            // Match: <modulePath>  (single module — no /versions sentinel)
            if (!hasVersionsSentinel) {
                const modulePath = unescapePath(relPath);
                const module = await moduleService.getModule(req, modulePath);
                if (!module) {
                    res.status(404).json(entityNotFound(req.originalUrl, 'module', modulePath));
                    return;
                }
                res.json(module);
                return;
            }

            next();
        })
    );

    return router;
}
