/**
 * Package and version routes.
 * Implements /pythonregistries/pypi/packages/* endpoints.
 */

import { NextFunction, Request, Response, Router } from 'express';
import { EntityStateManager } from '../../../shared/entity-state-manager';
import { getBaseUrl, REGISTRY_METADATA, SERVER_CONFIG } from '../config/constants';
import { PackageService } from '../services/package-service';
import { SearchService } from '../services/search-service';
import { normalizePackageId } from '../utils/identity';
import { entityNotFound } from '../utils/xregistry-errors';

export function createPackageRoutes(
    packageService: PackageService,
    searchService: SearchService,
    entityState: EntityStateManager
): Router {
    const router = Router();
    const { GROUP_TYPE, GROUP_ID, RESOURCE_TYPE } = REGISTRY_METADATA;

    const asyncHandler = (fn: Function) => {
        return (req: Request, res: Response, next: NextFunction) => {
            Promise.resolve(fn(req, res, next)).catch(next);
        };
    };

    const matchesFilter = (value: string, filterPattern: string): boolean => {
        if (filterPattern.includes('*')) {
            const pattern = filterPattern.replace(/\*/g, '.*');
            const regex = new RegExp(`^${pattern}$`, 'i');
            return regex.test(value);
        }

        return value.toLowerCase() === filterPattern.toLowerCase();
    };

    router.get(
        `/${GROUP_TYPE}/${GROUP_ID}/${RESOURCE_TYPE}`,
        asyncHandler(async (req: Request, res: Response): Promise<void> => {
            const baseUrl = getBaseUrl(req);
            const limit = req.query.limit
                ? parseInt(req.query.limit as string, 10)
                : SERVER_CONFIG.DEFAULT_PAGE_LIMIT;
            const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : 0;
            const filter = req.query.filter as string | undefined;
            const sort = req.query.sort as string | undefined;

            if (limit <= 0) {
                res.status(400).json({
                    type: 'https://github.com/xregistry/spec/blob/main/core/spec.md#invalid-input',
                    title: 'Invalid pagination parameter',
                    status: 400,
                    instance: req.originalUrl,
                    detail: 'Limit must be greater than 0',
                });
                return;
            }

            let allPackages = searchService.getAllPackages();

            if (filter) {
                const filterMatch = filter.match(/name=(.+)/i);
                if (filterMatch) {
                    let filterPattern = filterMatch[1] || '';
                    if (
                        filterPattern.length >= 2 &&
                        ((filterPattern.startsWith('\'') && filterPattern.endsWith('\'')) ||
                            (filterPattern.startsWith('"') && filterPattern.endsWith('"')))
                    ) {
                        filterPattern = filterPattern.slice(1, -1);
                    }
                    allPackages = allPackages.filter((pkg) => matchesFilter(pkg.name, filterPattern));
                } else {
                    allPackages = [];
                }
            }

            if (sort) {
                const sortParts = sort.split('=');
                if (sortParts.length === 2) {
                    const sortOrder = sortParts[1].toLowerCase();
                    allPackages = [...allPackages].sort((a, b) => {
                        const comparison = a.name.localeCompare(b.name, undefined, {
                            sensitivity: 'base',
                        });
                        return sortOrder === 'desc' ? -comparison : comparison;
                    });
                }
            }

            const paginatedPackages = allPackages.slice(offset, offset + limit);
            const packageEntries = await Promise.allSettled(
                paginatedPackages.map((pkg) => packageService.getPackageMetadata(pkg.name, baseUrl))
            );
            const packages: Record<string, any> = {};
            const resourceBasePath = `${baseUrl}/${GROUP_TYPE}/${GROUP_ID}/${RESOURCE_TYPE}`;

            for (let index = 0; index < paginatedPackages.length; index += 1) {
                const packageId = normalizePackageId(paginatedPackages[index]?.name || '');
                const entry = packageEntries[index];
                if (entry?.status === 'fulfilled') {
                    packages[packageId] = entry.value;
                    continue;
                }

                const resourcePath = `/${GROUP_TYPE}/${GROUP_ID}/${RESOURCE_TYPE}/${packageId}`;
                packages[packageId] = {
                    packageid: packageId,
                    xid: resourcePath,
                    self: `${resourceBasePath}/${packageId}`,
                    name: packageId,
                    versionid: '',
                    version: '',
                    epoch: entityState.getEpoch(resourcePath),
                    createdat: entityState.getCreatedAt(resourcePath),
                    modifiedat: entityState.getModifiedAt(resourcePath),
                    metaurl: `${resourceBasePath}/${packageId}/meta`,
                    versionsurl: `${resourceBasePath}/${packageId}/versions`,
                    versionscount: 0,
                };
            }

            const totalCount = allPackages.length;
            if (totalCount > 0) {
                const links: string[] = [];
                const queryParams = new URLSearchParams(req.query as Record<string, string>);

                if (offset > 0) {
                    queryParams.set('offset', '0');
                    queryParams.set('limit', limit.toString());
                    links.push(`<${baseUrl}${req.path}?${queryParams.toString()}>; rel="first"`);
                }

                if (offset > 0) {
                    const prevOffset = Math.max(0, offset - limit);
                    queryParams.set('offset', prevOffset.toString());
                    queryParams.set('limit', limit.toString());
                    links.push(`<${baseUrl}${req.path}?${queryParams.toString()}>; rel="prev"`);
                }

                if (offset + limit < totalCount) {
                    const nextOffset = offset + limit;
                    queryParams.set('offset', nextOffset.toString());
                    queryParams.set('limit', limit.toString());
                    links.push(`<${baseUrl}${req.path}?${queryParams.toString()}>; rel="next"`);
                }

                if (offset + limit < totalCount) {
                    const lastOffset = Math.floor((totalCount - 1) / limit) * limit;
                    queryParams.set('offset', lastOffset.toString());
                    queryParams.set('limit', limit.toString());
                    links.push(`<${baseUrl}${req.path}?${queryParams.toString()}>; rel="last"`);
                }

                links.push(`count="${totalCount}"`);
                links.push(`per-page="${limit}"`);
                res.set('Link', links.join(', '));
            }

            res.json(packages);
        })
    );

    router.get(
        `/${GROUP_TYPE}/${GROUP_ID}/${RESOURCE_TYPE}/:packageName/doc`,
        asyncHandler(async (req: Request, res: Response) => {
            const packageId = normalizePackageId(req.params['packageName']);
            const exists = await searchService.packageExists(packageId);
            if (!exists) {
                throw entityNotFound(req.originalUrl, 'package', packageId);
            }

            const { content, contentType } = await packageService.getPackageDoc(packageId);
            res.set('Content-Type', contentType);
            res.send(content);
        })
    );

    router.get(
        `/${GROUP_TYPE}/${GROUP_ID}/${RESOURCE_TYPE}/:packageName`,
        asyncHandler(async (req: Request, res: Response) => {
            const packageId = normalizePackageId(req.params['packageName']);
            const baseUrl = getBaseUrl(req);
            const exists = await searchService.packageExists(packageId);
            if (!exists) {
                throw entityNotFound(req.originalUrl, 'package', packageId);
            }

            const packageData = await packageService.getPackageMetadata(packageId, baseUrl);
            res.json(packageData);
        })
    );

    router.get(
        `/${GROUP_TYPE}/${GROUP_ID}/${RESOURCE_TYPE}/:packageName/meta`,
        asyncHandler(async (req: Request, res: Response) => {
            const packageId = normalizePackageId(req.params['packageName']);
            const baseUrl = getBaseUrl(req);
            const exists = await searchService.packageExists(packageId);
            if (!exists) {
                throw entityNotFound(req.originalUrl, 'package', packageId);
            }

            const metaData = await packageService.getPackageMeta(packageId, baseUrl);
            res.json(metaData);
        })
    );

    router.get(
        `/${GROUP_TYPE}/${GROUP_ID}/${RESOURCE_TYPE}/:packageName/versions`,
        asyncHandler(async (req: Request, res: Response) => {
            const packageId = normalizePackageId(req.params['packageName']);
            const baseUrl = getBaseUrl(req);
            const exists = await searchService.packageExists(packageId);
            if (!exists) {
                throw entityNotFound(req.originalUrl, 'package', packageId);
            }

            const versionsData = await packageService.getPackageVersions(packageId, baseUrl);
            res.json(versionsData);
        })
    );

    router.get(
        `/${GROUP_TYPE}/${GROUP_ID}/${RESOURCE_TYPE}/:packageName/versions/:versionId`,
        asyncHandler(async (req: Request, res: Response) => {
            const packageId = normalizePackageId(req.params['packageName']);
            const requestedVersionId = req.params['versionId'];
            const baseUrl = getBaseUrl(req);
            const exists = await searchService.packageExists(packageId);
            if (!exists) {
                throw entityNotFound(req.originalUrl, 'package', packageId);
            }

            const versionData = await packageService.getVersionDetails(
                packageId,
                requestedVersionId,
                baseUrl
            );
            res.json(versionData);
        })
    );

    return router;
}
