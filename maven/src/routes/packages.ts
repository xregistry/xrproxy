/**
 * Package Routes
 * @fileoverview Package and version endpoints for Maven wrapper
 */

import { Request, Response, Router } from 'express';
import { getBaseUrl, MAX_SOLR_ROWS, PAGINATION } from '../config/constants';
import { asyncHandler } from '../middleware/xregistry-error-handler';
import { PackageService } from '../services/package-service';

export interface PackageRoutesOptions {
    packageService: PackageService;
}

function parsePackageQuery(query: string | undefined, filter: string | undefined): string | undefined {
    if (query) {
        return query;
    }
    if (!filter) {
        return undefined;
    }
    const match = filter.match(/(?:name|artifact_id|packageid)\s*=\s*'?([^']+)'?/i);
    return match?.[1]?.trim();
}

function setCollectionLinks(res: Response, baseUrl: string, path: string, limit: number, offset: number, totalCount: number, query: Record<string, string | undefined>): void {
    if (totalCount <= 0) {
        return;
    }

    const headers: string[] = [];
    const queryParams = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) {
            queryParams.set(key, value);
        }
    }

    if (offset > 0) {
        queryParams.set('offset', '0');
        queryParams.set('limit', String(limit));
        headers.push(`<${baseUrl}${path}?${queryParams.toString()}>; rel="first"`);
        queryParams.set('offset', String(Math.max(0, offset - limit)));
        headers.push(`<${baseUrl}${path}?${queryParams.toString()}>; rel="prev"`);
    }

    if (offset + limit < totalCount) {
        queryParams.set('offset', String(offset + limit));
        queryParams.set('limit', String(limit));
        headers.push(`<${baseUrl}${path}?${queryParams.toString()}>; rel="next"`);
        const lastOffset = Math.floor((totalCount - 1) / limit) * limit;
        queryParams.set('offset', String(lastOffset));
        headers.push(`<${baseUrl}${path}?${queryParams.toString()}>; rel="last"`);
    }

    if (headers.length > 0) {
        res.setHeader('Link', headers.join(', '));
    }
}

export function createPackageRoutes(options: PackageRoutesOptions): Router {
    const router = Router();
    const { packageService } = options;

    router.get('/javanamespaces/:groupId/packages', asyncHandler(async (req: Request, res: Response) => {
        const namespaceId = req.params['groupId'];
        if (!namespaceId) {
            throw new Error('groupId is required');
        }
        const baseUrl = getBaseUrl(req);
        const limitParam = req.query['limit'];
        const requestedLimit = limitParam ? parseInt(limitParam as string, 10) : PAGINATION.DEFAULT_PAGE_LIMIT;
        const offset = parseInt(req.query['offset'] as string, 10) || PAGINATION.DEFAULT_OFFSET;

        if (limitParam !== undefined && (isNaN(requestedLimit) || requestedLimit <= 0)) {
            res.status(400).json({
                type: 'about:blank',
                title: 'Bad Request',
                status: 400,
                detail: 'The limit parameter must be a positive integer',
                instance: req.originalUrl
            });
            return;
        }

        const limit = Math.min(requestedLimit, MAX_SOLR_ROWS);
        const query = parsePackageQuery(req.query['q'] as string | undefined, req.query['filter'] as string | undefined);
        const sort = req.query['sort'] as string | undefined;
        const packageOptions: { limit: number; offset: number; query?: string; sort?: string } = { limit, offset };
        if (query) packageOptions.query = query;
        if (sort) packageOptions.sort = sort;

        const result = await packageService.getAllPackages(namespaceId, baseUrl, packageOptions);
        res.setHeader('X-Total-Count', String(result.totalCount));
        setCollectionLinks(res, baseUrl, req.path, limit, offset, result.totalCount, req.query as Record<string, string | undefined>);
        res.json(result.packages);
    }));

    router.get('/javanamespaces/:groupId/packages/:packageId', asyncHandler(async (req: Request, res: Response) => {
        const { groupId, packageId } = req.params;
        if (!groupId || !packageId) {
            throw new Error('groupId and packageId are required');
        }
        const baseUrl = getBaseUrl(req);
        res.json(await packageService.getPackage(groupId, packageId, baseUrl));
    }));

    router.get('/javanamespaces/:groupId/packages/:packageId/meta', asyncHandler(async (req: Request, res: Response) => {
        const { groupId, packageId } = req.params;
        if (!groupId || !packageId) {
            throw new Error('groupId and packageId are required');
        }
        const baseUrl = getBaseUrl(req);
        const pkg = await packageService.getPackage(groupId, packageId, baseUrl);
        const versionId = pkg.versionid as string | undefined;
        const metaPath = `/javanamespaces/${groupId}/packages/${packageId}/meta`;

        res.json({
            packageid: packageId,
            xid: metaPath,
            self: `${baseUrl}${metaPath}`,
            epoch: pkg.epoch,
            createdat: pkg.createdat,
            modifiedat: pkg.modifiedat,
            readonly: true,
            defaultversionid: versionId,
            defaultversionurl: versionId ? `${baseUrl}/javanamespaces/${groupId}/packages/${packageId}/versions/${versionId}` : undefined,
            defaultversionsticky: false
        });
    }));

    router.get('/javanamespaces/:groupId/packages/:packageId/versions', asyncHandler(async (req: Request, res: Response) => {
        const { groupId, packageId } = req.params;
        if (!groupId || !packageId) {
            throw new Error('groupId and packageId are required');
        }
        const baseUrl = getBaseUrl(req);
        const limit = parseInt(req.query['limit'] as string, 10) || PAGINATION.DEFAULT_PAGE_LIMIT;
        const offset = parseInt(req.query['offset'] as string, 10) || PAGINATION.DEFAULT_OFFSET;
        const sort = req.query['sort'] as string | undefined;
        const versionOptions: { limit: number; offset: number; sort?: string } = { limit, offset };
        if (sort) versionOptions.sort = sort;

        const result = await packageService.getPackageVersions(groupId, packageId, baseUrl, versionOptions);
        res.setHeader('X-Total-Count', String(result.totalCount));
        setCollectionLinks(res, baseUrl, req.path, limit, offset, result.totalCount, req.query as Record<string, string | undefined>);
        res.json(result.versions);
    }));

    router.get('/javanamespaces/:groupId/packages/:packageId/versions/:version', asyncHandler(async (req: Request, res: Response) => {
        const { groupId, packageId, version } = req.params;
        if (!groupId || !packageId || !version) {
            throw new Error('groupId, packageId, and version are required');
        }
        const baseUrl = getBaseUrl(req);
        res.json(await packageService.getVersion(groupId, packageId, version, baseUrl));
    }));

    return router;
}
