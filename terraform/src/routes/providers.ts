/**
 * Provider routes
 * /terraformregistries/registry.terraform.io/providers/*
 */

import { NextFunction, Request, Response, Router } from 'express';
import { EntityStateManager } from '../../../shared/entity-state-manager';
import {
    decodeProviderId,
    getBaseUrl,
    REGISTRY_METADATA,
    SERVER_CONFIG,
} from '../config/constants';
import { ProviderService } from '../services/provider-service';
import { SearchService } from '../services/search-service';
import { entityNotFound } from '../utils/xregistry-errors';

const asyncHandler = (fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) =>
    (req: Request, res: Response, next: NextFunction): void => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };

/** Simple wildcard filter on a string field */
function matchesFilter(value: string, pattern: string): boolean {
    if (pattern.includes('*')) {
        const re = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$', 'i');
        return re.test(value);
    }
    return value.toLowerCase() === pattern.toLowerCase();
}

export function createProviderRoutes(
    providerService: ProviderService,
    searchService: SearchService,
    entityState: EntityStateManager
): Router {
    const router = Router();
    const { GROUP_TYPE, GROUP_ID, PROVIDER_RESOURCE_TYPE } = REGISTRY_METADATA;
    const base = `/${GROUP_TYPE}/${GROUP_ID}/${PROVIDER_RESOURCE_TYPE}`;

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

        let all = searchService.getAllProviders();

        if (filter) {
            const m = filter.match(/(?:type|id)=(.+)/i);
            if (m) all = all.filter((p) => matchesFilter(p.type, m[1]) || matchesFilter(p.id, m[1]));
            else if (filter.match(/namespace=(.+)/i)) {
                const nsm = filter.match(/namespace=(.+)/i)!;
                all = all.filter((p) => matchesFilter(p.namespace, nsm[1]));
            } else {
                all = [];
            }
        }

        if (sort) {
            const parts = sort.split('=');
            const field = parts[0] as 'namespace' | 'type' | 'id';
            const dir = parts[1]?.toLowerCase() === 'desc' ? -1 : 1;
            all = [...all].sort((a, b) => (a[field] ?? '').localeCompare(b[field] ?? '') * dir);
        }

        const totalCount = all.length;
        const page = all.slice(offset, offset + limit);

        const result: Record<string, unknown> = {};
        const resourceBase = `${baseUrl}${base}`;
        for (const p of page) {
            const resourcePath = `${base}/${p.id}`;
            result[p.id] = {
                providerid: p.id,
                xid: resourcePath,
                self: `${resourceBase}/${p.id}`,
                epoch: entityState.getEpoch(resourcePath),
                createdat: entityState.getCreatedAt(resourcePath),
                modifiedat: entityState.getModifiedAt(resourcePath),
                namespace: p.namespace,
                type: p.type,
            };
        }

        if (totalCount > 0) {
            const links: string[] = [];
            // Build safe string-only query params
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
    // Single provider resource
    // ------------------------------------------------------------------
    router.get(`${base}/:providerId`, asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const providerId = String(req.params['providerId']);
        const decoded = decodeProviderId(providerId);
        if (!decoded) {
            throw entityNotFound(req.originalUrl, 'provider', providerId);
        }
        const exists = await searchService.providerExists(decoded.namespace, decoded.type);
        if (!exists) throw entityNotFound(req.originalUrl, 'provider', providerId);

        const data = await providerService.getProviderMetadata(providerId, getBaseUrl(req));
        res.json(data);
    }));

    // ------------------------------------------------------------------
    // Meta sub-resource
    // ------------------------------------------------------------------
    router.get(`${base}/:providerId/meta`, asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const providerId = String(req.params['providerId']);
        const decoded = decodeProviderId(providerId);
        if (!decoded) throw entityNotFound(req.originalUrl, 'provider', providerId);
        const exists = await searchService.providerExists(decoded.namespace, decoded.type);
        if (!exists) throw entityNotFound(req.originalUrl, 'provider', providerId);

        const data = await providerService.getProviderMeta(providerId, getBaseUrl(req));
        res.json(data);
    }));

    // ------------------------------------------------------------------
    // Versions collection
    // ------------------------------------------------------------------
    router.get(`${base}/:providerId/versions`, asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const providerId = String(req.params['providerId']);
        const decoded = decodeProviderId(providerId);
        if (!decoded) throw entityNotFound(req.originalUrl, 'provider', providerId);
        const exists = await searchService.providerExists(decoded.namespace, decoded.type);
        if (!exists) throw entityNotFound(req.originalUrl, 'provider', providerId);

        const data = await providerService.getProviderVersions(providerId, getBaseUrl(req));
        res.json(data);
    }));

    // ------------------------------------------------------------------
    // Single version
    // ------------------------------------------------------------------
    router.get(`${base}/:providerId/versions/:versionId`, asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const providerId = String(req.params['providerId']);
        const versionId = String(req.params['versionId']);
        const decoded = decodeProviderId(providerId);
        if (!decoded) throw entityNotFound(req.originalUrl, 'provider', providerId);
        const exists = await searchService.providerExists(decoded.namespace, decoded.type);
        if (!exists) throw entityNotFound(req.originalUrl, 'provider', providerId);

        const data = await providerService.getProviderVersion(providerId, versionId, getBaseUrl(req));
        res.json(data);
    }));

    return router;
}
