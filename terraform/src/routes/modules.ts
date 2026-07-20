/** Terraform module routes grouped by canonical upstream namespace. */

import { NextFunction, Request, Response, Router } from 'express';
import { EntityStateManager } from '../../../shared/entity-state-manager';
import { getBaseUrl, isTerraformIdentifier, REGISTRY_METADATA } from '../config/constants';
import { ModuleService } from '../services/module-service';
import { SearchService } from '../services/search-service';
import { parsePagination, setPaginationHeaders } from '../utils/collection';
import { entityNotFound, invalidData } from '../utils/xregistry-errors';

const asyncHandler = (fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) =>
    (req: Request, res: Response, next: NextFunction): void => { void Promise.resolve(fn(req, res, next)).catch(next); };

export function createModuleRoutes(
    moduleService: ModuleService,
    searchService: SearchService,
    _entityState: EntityStateManager
): Router {
    const router = Router();
    const { GROUP_TYPE, MODULE_RESOURCE_TYPE } = REGISTRY_METADATA;
    const base = `/${GROUP_TYPE}/:groupId/${MODULE_RESOURCE_TYPE}`;

    const canonicalPath = (req: Request, entity: Record<string, unknown>, suffix = ''): string => {
        const queryIndex = req.originalUrl.indexOf('?');
        const query = queryIndex === -1 ? '' : req.originalUrl.slice(queryIndex);
        return `${getBaseUrl(req)}/${GROUP_TYPE}/${encodeURIComponent(String(entity['namespace']))}/${MODULE_RESOURCE_TYPE}/${encodeURIComponent(String(entity['moduleid']))}${suffix}${query}`;
    };

    const resolveResource = async (req: Request): Promise<Record<string, unknown>> => {
        const groupId = String(req.params['groupId'] ?? '');
        const moduleId = String(req.params['moduleId'] ?? '');
        const entity = await moduleService.getModuleMetadata(groupId, moduleId, getBaseUrl(req));
        searchService.registerModule(
            String(entity['namespace']), String(entity['name']), String(entity['provider']),
        );
        return entity;
    };

    const redirectIfAlias = (req: Request, res: Response, entity: Record<string, unknown>, suffix = ''): boolean => {
        const groupId = String(req.params['groupId'] ?? '');
        const moduleId = String(req.params['moduleId'] ?? '');
        if (entity['namespace'] !== groupId || entity['moduleid'] !== moduleId) {
            res.redirect(308, canonicalPath(req, entity, suffix));
            return true;
        }
        return false;
    };

    router.get(base, asyncHandler(async (req, res) => {
        const groupId = String(req.params['groupId'] ?? '');
        if (!isTerraformIdentifier(groupId)) {
            throw invalidData(req.originalUrl, 'groupId', 'Terraform namespace IDs contain only alphanumerics, underscore, and hyphen.');
        }
        if (req.query['filter'] !== undefined || req.query['sort'] !== undefined) {
            throw invalidData(req.originalUrl, 'filter', 'Terraform discovery snapshots do not support filter or sort.');
        }
        const namespace = await searchService.resolveNamespace(groupId);
        if (!namespace || namespace.namespace !== groupId) {
            throw entityNotFound(req.originalUrl, 'terraformregistry', groupId);
        }
        const discovered = searchService.getModules(groupId)
            .sort((a, b) => a.id.localeCompare(b.id));
        const { offset, limit } = parsePagination(req);
        const page = discovered.slice(offset, offset + limit);
        const completePage = await Promise.all(page.map(module =>
            moduleService.getModuleMetadata(module.namespace, module.id, getBaseUrl(req)),
        ));

        const body: Record<string, unknown> = {};
        for (const entity of completePage) body[String(entity['moduleid'])] = entity;
        setPaginationHeaders(req, res, offset, limit, discovered.length, false);
        res.json(body);
    }));

    router.get(`${base}/:moduleId`, asyncHandler(async (req, res) => {
        const entity = await resolveResource(req);
        if (redirectIfAlias(req, res, entity)) return;
        res.json(entity);
    }));

    router.get(`${base}/:moduleId/meta`, asyncHandler(async (req, res) => {
        const entity = await resolveResource(req);
        if (redirectIfAlias(req, res, entity, '/meta')) return;
        res.json(await moduleService.getModuleMeta(
            String(entity['namespace']), String(entity['moduleid']), getBaseUrl(req),
        ));
    }));

    router.get(`${base}/:moduleId/versions`, asyncHandler(async (req, res) => {
        const entity = await resolveResource(req);
        if (redirectIfAlias(req, res, entity, '/versions')) return;
        if (req.query['filter'] !== undefined || req.query['sort'] !== undefined) {
            throw invalidData(req.originalUrl, 'filter', 'Terraform version collections do not support filter or sort.');
        }
        const all = await moduleService.getModuleVersions(
            String(entity['namespace']), String(entity['moduleid']), getBaseUrl(req),
        );
        const entries = Object.entries(all).sort(([a], [b]) => a.localeCompare(b));
        const { offset, limit } = parsePagination(req);
        const body = Object.fromEntries(entries.slice(offset, offset + limit));
        setPaginationHeaders(req, res, offset, limit, entries.length);
        res.json(body);
    }));

    router.get(`${base}/:moduleId/versions/:versionId`, asyncHandler(async (req, res) => {
        const versionId = String(req.params['versionId'] ?? '');
        const entity = await resolveResource(req);
        if (redirectIfAlias(req, res, entity, `/versions/${encodeURIComponent(versionId)}`)) return;
        res.json(await moduleService.getModuleVersion(
            String(entity['namespace']), String(entity['moduleid']), versionId, getBaseUrl(req),
        ));
    }));

    return router;
}
