/**
 * Module routes
 * /terraformregistries/registry.terraform.io/modules/*
 */

import { NextFunction, Request, Response, Router } from 'express';
import { EntityStateManager } from '../../../shared/entity-state-manager';
import {
    decodeModuleId,
    getBaseUrl,
    REGISTRY_METADATA,
    SERVER_CONFIG,
} from '../config/constants';
import { ModuleService } from '../services/module-service';
import { SearchService } from '../services/search-service';
import { entityNotFound } from '../utils/xregistry-errors';

const asyncHandler = (fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) =>
    (req: Request, res: Response, next: NextFunction): void => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };

function matchesFilter(value: string, pattern: string): boolean {
    if (pattern.includes('*')) {
        const re = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$', 'i');
        return re.test(value);
    }
    return value.toLowerCase() === pattern.toLowerCase();
}

export function createModuleRoutes(
    moduleService: ModuleService,
    searchService: SearchService,
    entityState: EntityStateManager
): Router {
    const router = Router();
    const { GROUP_TYPE, GROUP_ID, MODULE_RESOURCE_TYPE } = REGISTRY_METADATA;
    const base = `/${GROUP_TYPE}/${GROUP_ID}/${MODULE_RESOURCE_TYPE}`;

    // ------------------------------------------------------------------
    // Collection
    // ------------------------------------------------------------------
    router.get(base, asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const baseUrl = getBaseUrl(req);
        const limit = Math.max(1, parseInt((req.query['limit'] as string) || String(SERVER_CONFIG.DEFAULT_PAGE_LIMIT), 10));
        const offset = Math.max(0, parseInt((req.query['offset'] as string) || '0', 10));
        const filterRaw = req.query['filter'];
        const filter = Array.isArray(filterRaw) ? filterRaw[0] as string : filterRaw as string | undefined;
        const sortRaw = req.query['sort'];
        const sort = Array.isArray(sortRaw) ? sortRaw[0] as string : sortRaw as string | undefined;

        let all = searchService.getAllModules();

        if (filter) {
            const nameM = filter.match(/name=(.+)/i);
            const nsM = filter.match(/namespace=(.+)/i);
            const provM = filter.match(/provider=(.+)/i);
            if (nameM) all = all.filter((m) => matchesFilter(m.name, nameM[1]));
            else if (nsM) all = all.filter((m) => matchesFilter(m.namespace, nsM[1]));
            else if (provM) all = all.filter((m) => matchesFilter(m.provider, provM[1]));
            else all = [];
        }

        if (sort) {
            const parts = sort.split('=');
            const field = parts[0] as 'namespace' | 'name' | 'provider' | 'id';
            const dir = parts[1]?.toLowerCase() === 'desc' ? -1 : 1;
            all = [...all].sort((a, b) => (a[field] ?? '').localeCompare(b[field] ?? '') * dir);
        }

        const totalCount = all.length;
        const page = all.slice(offset, offset + limit);

        const result: Record<string, unknown> = {};
        const resourceBase = `${baseUrl}${base}`;
        for (const m of page) {
            const resourcePath = `${base}/${m.id}`;
            result[m.id] = {
                moduleid: m.id,
                xid: resourcePath,
                self: `${resourceBase}/${m.id}`,
                epoch: entityState.getEpoch(resourcePath),
                createdat: entityState.getCreatedAt(resourcePath),
                modifiedat: entityState.getModifiedAt(resourcePath),
                namespace: m.namespace,
                name: m.name,
                provider: m.provider,
            };
        }

        if (totalCount > 0) {
            const links: string[] = [];
            const safeQuery: Record<string, string> = {};
            for (const [k, v] of Object.entries(req.query)) {
                if (typeof v === 'string') safeQuery[k] = v;
            }
            const q = new URLSearchParams(safeQuery);
            if (offset > 0) {
                q.set('offset', '0'); q.set('limit', String(limit));
                links.push(`<${baseUrl}${base}?${q}>; rel="first"`);
                q.set('offset', String(Math.max(0, offset - limit)));
                links.push(`<${baseUrl}${base}?${q}>; rel="prev"`);
            }
            if (offset + limit < totalCount) {
                q.set('offset', String(offset + limit)); q.set('limit', String(limit));
                links.push(`<${baseUrl}${base}?${q}>; rel="next"`);
                q.set('offset', String(Math.floor((totalCount - 1) / limit) * limit));
                links.push(`<${baseUrl}${base}?${q}>; rel="last"`);
            }
            links.push(`count="${totalCount}"`, `per-page="${limit}"`);
            res.set('Link', links.join(', '));
        }

        res.json(result);
    }));

    // ------------------------------------------------------------------
    // Single module resource
    // ------------------------------------------------------------------
    router.get(`${base}/:moduleId`, asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const moduleId = String(req.params['moduleId']);
        const decoded = decodeModuleId(moduleId);
        if (!decoded) throw entityNotFound(req.originalUrl, 'module', moduleId);
        const exists = await searchService.moduleExists(decoded.namespace, decoded.name, decoded.provider);
        if (!exists) throw entityNotFound(req.originalUrl, 'module', moduleId);

        const data = await moduleService.getModuleMetadata(moduleId, getBaseUrl(req));
        res.json(data);
    }));

    // ------------------------------------------------------------------
    // Meta sub-resource
    // ------------------------------------------------------------------
    router.get(`${base}/:moduleId/meta`, asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const moduleId = String(req.params['moduleId']);
        const decoded = decodeModuleId(moduleId);
        if (!decoded) throw entityNotFound(req.originalUrl, 'module', moduleId);
        const exists = await searchService.moduleExists(decoded.namespace, decoded.name, decoded.provider);
        if (!exists) throw entityNotFound(req.originalUrl, 'module', moduleId);

        const data = await moduleService.getModuleMeta(moduleId, getBaseUrl(req));
        res.json(data);
    }));

    // ------------------------------------------------------------------
    // Versions collection
    // ------------------------------------------------------------------
    router.get(`${base}/:moduleId/versions`, asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const moduleId = String(req.params['moduleId']);
        const decoded = decodeModuleId(moduleId);
        if (!decoded) throw entityNotFound(req.originalUrl, 'module', moduleId);
        const exists = await searchService.moduleExists(decoded.namespace, decoded.name, decoded.provider);
        if (!exists) throw entityNotFound(req.originalUrl, 'module', moduleId);

        const data = await moduleService.getModuleVersions(moduleId, getBaseUrl(req));
        res.json(data);
    }));

    // ------------------------------------------------------------------
    // Single version
    // ------------------------------------------------------------------
    router.get(`${base}/:moduleId/versions/:versionId`, asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const moduleId = String(req.params['moduleId']);
        const versionId = String(req.params['versionId']);
        const decoded = decodeModuleId(moduleId);
        if (!decoded) throw entityNotFound(req.originalUrl, 'module', moduleId);
        const exists = await searchService.moduleExists(decoded.namespace, decoded.name, decoded.provider);
        if (!exists) throw entityNotFound(req.originalUrl, 'module', moduleId);

        const data = await moduleService.getModuleVersion(moduleId, versionId, getBaseUrl(req));
        res.json(data);
    }));

    return router;
}
