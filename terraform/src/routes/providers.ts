/** Terraform provider routes grouped by canonical upstream namespace. */

import { NextFunction, Request, Response, Router } from 'express';
import { EntityStateManager } from '../../../shared/entity-state-manager';
import { getBaseUrl, isTerraformIdentifier, REGISTRY_METADATA } from '../config/constants';
import { ProviderService } from '../services/provider-service';
import { SearchService } from '../services/search-service';
import { parsePagination, setPaginationHeaders } from '../utils/collection';
import { entityNotFound, invalidData } from '../utils/xregistry-errors';

const asyncHandler = (fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) =>
    (req: Request, res: Response, next: NextFunction): void => { void Promise.resolve(fn(req, res, next)).catch(next); };

export function createProviderRoutes(
    providerService: ProviderService,
    searchService: SearchService,
    _entityState: EntityStateManager
): Router {
    const router = Router();
    const { GROUP_TYPE, PROVIDER_RESOURCE_TYPE } = REGISTRY_METADATA;
    const base = `/${GROUP_TYPE}/:groupId/${PROVIDER_RESOURCE_TYPE}`;

    const canonicalPath = (req: Request, entity: Record<string, unknown>, suffix = ''): string => {
        const queryIndex = req.originalUrl.indexOf('?');
        const query = queryIndex === -1 ? '' : req.originalUrl.slice(queryIndex);
        return `${getBaseUrl(req)}/${GROUP_TYPE}/${encodeURIComponent(String(entity['namespace']))}/${PROVIDER_RESOURCE_TYPE}/${encodeURIComponent(String(entity['providerid']))}${suffix}${query}`;
    };

    const resolveResource = async (req: Request): Promise<Record<string, unknown>> => {
        const groupId = String(req.params['groupId'] ?? '');
        const providerId = String(req.params['providerId'] ?? '');
        const entity = await providerService.getProviderMetadata(groupId, providerId, getBaseUrl(req));
        searchService.registerProvider(String(entity['namespace']), String(entity['providerid']));
        return entity;
    };

    const redirectIfAlias = (req: Request, res: Response, entity: Record<string, unknown>, suffix = ''): boolean => {
        const groupId = String(req.params['groupId'] ?? '');
        const providerId = String(req.params['providerId'] ?? '');
        if (entity['namespace'] !== groupId || entity['providerid'] !== providerId) {
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
        const discovered = searchService.getProviders(groupId)
            .sort((a, b) => a.type.localeCompare(b.type));
        const { offset, limit } = parsePagination(req);
        const page = discovered.slice(offset, offset + limit);
        const completePage = await Promise.all(page.map(provider =>
            providerService.getProviderMetadata(provider.namespace, provider.type, getBaseUrl(req)),
        ));

        const body: Record<string, unknown> = {};
        for (const entity of completePage) body[String(entity['providerid'])] = entity;
        setPaginationHeaders(req, res, offset, limit, discovered.length, false);
        res.json(body);
    }));

    router.get(`${base}/:providerId`, asyncHandler(async (req, res) => {
        const entity = await resolveResource(req);
        if (redirectIfAlias(req, res, entity)) return;
        res.json(entity);
    }));

    router.get(`${base}/:providerId/meta`, asyncHandler(async (req, res) => {
        const entity = await resolveResource(req);
        if (redirectIfAlias(req, res, entity, '/meta')) return;
        res.json(await providerService.getProviderMeta(
            String(entity['namespace']), String(entity['providerid']), getBaseUrl(req),
        ));
    }));

    router.get(`${base}/:providerId/versions`, asyncHandler(async (req, res) => {
        const entity = await resolveResource(req);
        if (redirectIfAlias(req, res, entity, '/versions')) return;
        if (req.query['filter'] !== undefined || req.query['sort'] !== undefined) {
            throw invalidData(req.originalUrl, 'filter', 'Terraform version collections do not support filter or sort.');
        }
        const all = await providerService.getProviderVersions(
            String(entity['namespace']), String(entity['providerid']), getBaseUrl(req),
        );
        const entries = Object.entries(all).sort(([a], [b]) => a.localeCompare(b));
        const { offset, limit } = parsePagination(req);
        const body = Object.fromEntries(entries.slice(offset, offset + limit));
        setPaginationHeaders(req, res, offset, limit, entries.length);
        res.json(body);
    }));

    router.get(`${base}/:providerId/versions/:versionId`, asyncHandler(async (req, res) => {
        const versionId = String(req.params['versionId'] ?? '');
        const entity = await resolveResource(req);
        if (redirectIfAlias(req, res, entity, `/versions/${encodeURIComponent(versionId)}`)) return;
        res.json(await providerService.getProviderVersion(
            String(entity['namespace']), String(entity['providerid']), versionId, getBaseUrl(req),
        ));
    }));

    return router;
}
