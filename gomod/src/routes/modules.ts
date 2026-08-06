/**
 * Module and version routes.
 *
 * Go's native namespace maps to the xRegistry group ID. The remaining module
 * path is encoded as one colon-delimited xRegistry resource ID unless the
 * specification requires the reserved `@` root marker or the `xh~...` hash
 * fallback for case collisions and overlong IDs.
 */

import { NextFunction, Request, Response, Router } from 'express';
import { getBaseUrl, REGISTRY_METADATA, SERVER_CONFIG } from '../config/constants';
import { CheckpointService } from '../services/checkpoint-service';
import { ModuleService } from '../services/module-service';
import {
    identityToModulePath,
    isHashedModuleId,
    versionIdToVersion,
    versionToId,
} from '../utils/path-escaping';
import { entityNotFound } from '../utils/xregistry-errors';
import { buildPaginationLinkHeader } from '../utils/pagination';

const { GROUP_TYPE, RESOURCE_TYPE } = REGISTRY_METADATA;

function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) {
    return (req: Request, res: Response, next: NextFunction): void => {
        fn(req, res, next).catch(next);
    };
}

class InvalidRouteIdentityError extends Error {
    readonly status = 400;
    readonly title: string;

    constructor(message: string) {
        super(message);
        this.title = message;
    }
}

function routeParam(req: Request, name: string): string {
    const value = req.params[name];
    if (typeof value !== 'string' || value.length === 0) {
        throw new InvalidRouteIdentityError(`Missing route parameter: ${name}`);
    }
    return value;
}

function modulePathFromRoute(req: Request, checkpointService: CheckpointService): string | null {
    const groupId = routeParam(req, 'groupId');
    const moduleId = routeParam(req, 'moduleId');

    const knownPath = checkpointService.resolveModulePath(groupId, moduleId);
    if (knownPath) return knownPath;
    if (isHashedModuleId(moduleId)) return null;

    try {
        return identityToModulePath(groupId, moduleId);
    } catch {
        throw new InvalidRouteIdentityError('Invalid Go module group/resource identity');
    }
}

export function createModuleRoutes(
    moduleService: ModuleService,
    checkpointService: CheckpointService
): Router {
    const router = Router();
    const collectionPath = `/${GROUP_TYPE}/:groupId/${RESOURCE_TYPE}`;

    router.get(
        collectionPath,
        asyncHandler(async (req: Request, res: Response): Promise<void> => {
            const baseUrl = getBaseUrl(req);
            const limit = Math.min(
                parseInt(String(req.query['limit'] ?? SERVER_CONFIG.DEFAULT_PAGE_LIMIT), 10),
                SERVER_CONFIG.MAX_PAGE_LIMIT
            );
            const offset = Math.max(parseInt(String(req.query['offset'] ?? '0'), 10), 0);
            const filterParam = req.query['filter'] as string | undefined;
            const groupId = routeParam(req, 'groupId');

            if (isNaN(limit) || limit <= 0) {
                res.status(400).json({ type: 'about:blank', title: 'limit must be > 0', status: 400, instance: req.originalUrl });
                return;
            }

            const nameMatch = filterParam?.match(/(?:name|modulepath|moduleid)=(.+)/i);
            const pattern = filterParam ? (nameMatch ? nameMatch[1] : filterParam) : undefined;
            const result = checkpointService.listGroupModulePaths(groupId, pattern, offset, limit);
            const { paths, totalMatched: totalKnown } = result;

            const modules: Record<string, unknown> = {};
            for (const modulePath of paths) {
                const catalogEntry = checkpointService.getModule(modulePath);
                const { moduleId } = checkpointService.getModuleIdentity(modulePath);
                const xp = `/${GROUP_TYPE}/${groupId}/${RESOURCE_TYPE}/${moduleId}`;
                const selfUrl = `${baseUrl}/${GROUP_TYPE}/${encodeURIComponent(groupId)}/${RESOURCE_TYPE}/${encodeURIComponent(moduleId)}`;
                modules[moduleId] = {
                    moduleid: moduleId,
                    ...(catalogEntry?.latestVersion ? {
                        versionid: versionToId(catalogEntry.latestVersion),
                        version: catalogEntry.latestVersion,
                        meta: { latest_version: catalogEntry.latestVersion },
                    } : {}),
                    isdefault: true,
                    xid: xp,
                    name: modulePath,
                    modulepath: modulePath,
                    self: selfUrl,
                    versionsurl: `${selfUrl}/versions`,
                    versionscount: catalogEntry ? catalogEntry.versions.length : undefined,
                };
            }

            const collectionUrl = `${baseUrl}/${GROUP_TYPE}/${encodeURIComponent(groupId)}/${RESOURCE_TYPE}`;
            res.setHeader('X-Total-Count', String(totalKnown));
            const linkHeader = buildPaginationLinkHeader(collectionUrl, offset, limit, totalKnown, { filter: filterParam });
            if (linkHeader) res.setHeader('Link', linkHeader);

            res.json(modules);
        })
    );

    router.get(
        `${collectionPath}/:moduleId/versions/:versionId`,
        asyncHandler(async (req: Request, res: Response): Promise<void> => {
            const modulePath = modulePathFromRoute(req, checkpointService);
            if (!modulePath) {
                res.status(404).json(entityNotFound(req.originalUrl, 'module', `${routeParam(req, 'groupId')}/${routeParam(req, 'moduleId')}`));
                return;
            }
            const version = versionIdToVersion(routeParam(req, 'versionId'));
            const record = await moduleService.getVersion(req, modulePath, version);
            if (!record) {
                res.status(404).json(entityNotFound(req.originalUrl, 'version', `${modulePath}@${version}`));
                return;
            }
            res.json(record);
        })
    );

    router.get(
        `${collectionPath}/:moduleId/versions`,
        asyncHandler(async (req: Request, res: Response): Promise<void> => {
            const baseUrl = getBaseUrl(req);
            const groupId = routeParam(req, 'groupId');
            const moduleId = routeParam(req, 'moduleId');
            const modulePath = modulePathFromRoute(req, checkpointService);
            if (!modulePath) {
                res.status(404).json(entityNotFound(req.originalUrl, 'module', `${groupId}/${moduleId}`));
                return;
            }

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
            const versionsUrl = `${baseUrl}/${GROUP_TYPE}/${encodeURIComponent(groupId)}/${RESOURCE_TYPE}/${encodeURIComponent(moduleId)}/versions`;
            res.setHeader('X-Total-Count', String(totalCount));
            const linkHeader = buildPaginationLinkHeader(versionsUrl, offset, limit, totalCount);
            if (linkHeader) res.setHeader('Link', linkHeader);

            const body: Record<string, unknown> = {};
            for (const version of versions) {
                body[version.versionid] = version;
            }
            res.json(body);
        })
    );

    router.get(
        `${collectionPath}/:moduleId`,
        asyncHandler(async (req: Request, res: Response): Promise<void> => {
            const modulePath = modulePathFromRoute(req, checkpointService);
            if (!modulePath) {
                res.status(404).json(entityNotFound(req.originalUrl, 'module', `${routeParam(req, 'groupId')}/${routeParam(req, 'moduleId')}`));
                return;
            }
            const module = await moduleService.getModule(req, modulePath);
            if (!module) {
                res.status(404).json(entityNotFound(req.originalUrl, 'module', modulePath));
                return;
            }
            res.json(module);
        })
    );

    return router;
}
