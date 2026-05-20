/**
 * Package Routes
 * @fileoverview Package and version endpoints for Maven wrapper
 */

import { Request, Response, Router } from 'express';
import { getBaseUrl, MAX_SOLR_ROWS, PAGINATION } from '../config/constants';
import { asyncHandler } from '../middleware/xregistry-error-handler';
import { PackageService } from '../services/package-service';
import { SearchService } from '../services/search-service';

export interface PackageRoutesOptions {
    packageService: PackageService;
    searchService: SearchService;
}

/**
 * Create package routes
 */
export function createPackageRoutes(options: PackageRoutesOptions): Router {
    const router = Router();
    const { packageService, searchService } = options;

    /**
     * GET /javaregistries/:groupId/packages - List all packages
     */
    router.get(
        '/javaregistries/:groupId/packages',
        asyncHandler(async (req: Request, res: Response) => {
            const { groupId } = req.params;
            if (!groupId) {
                throw new Error('groupId is required');
            }
            const baseUrl = getBaseUrl(req);

            // Parse pagination parameters
            const limitParam = req.query['limit'];
            const requestedLimit = limitParam
                ? parseInt(limitParam as string)
                : PAGINATION.DEFAULT_PAGE_LIMIT;
            const offset = parseInt(req.query['offset'] as string) || PAGINATION.DEFAULT_OFFSET;
            const query = req.query['q'] as string;
            const filter = req.query['filter'] as string;
            const sort = req.query['sort'] as string;

            // Validate limit parameter
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

            // Maven Central's Solr `rows` is capped at 200; clamp here so
            // pagination metadata reflects what we actually fetch.
            const limit = Math.min(requestedLimit, MAX_SOLR_ROWS);

            // Build the search query from either `q` or `filter=name=…`.
            let searchQuery = query || '*:*';

            if (filter) {
                const filterMatch = filter.match(/name\s*=\s*'?([^']+)'?/i);
                if (filterMatch && filterMatch[1]) {
                    // Strip surrounding quotes from xRegistry filter syntax.
                    searchQuery = filterMatch[1].trim();
                    if (!searchQuery) {
                        searchQuery = '*:*';
                    }
                } else {
                    // Unsupported filter shape: return empty rather than guess.
                    res.json({});
                    return;
                }
            }

            const searchResult = await searchService.searchPackages({
                query: searchQuery,
                limit,
                offset
            });

            const packages: Record<string, any> = {};
            const packageList = searchResult.results.map((result) => {
                const packageId = `${result.groupId}:${result.artifactId}`;
                const packagePath = `${baseUrl}/javaregistries/${groupId}/packages/${packageId}`;
                return {
                    xid: `/javaregistries/${groupId}/packages/${packageId}`,
                    self: packagePath,
                    name: result.artifactId,
                    packageid: packageId,
                    epoch: 1,
                    createdat: new Date(result.timestamp).toISOString(),
                    modifiedat: new Date(result.timestamp).toISOString(),
                    versionsurl: `${packagePath}/versions`,
                    versionscount: result.versionCount || 1,
                    groupId: result.groupId,
                    artifactId: result.artifactId,
                    latestVersion: result.latestVersion
                };
            });

            // Apply sort to the current page only. Solr's own sort options
            // aren't reliable across shards for lexicographic order, so we
            // honour the client's `sort=field=asc|desc` request best-effort
            // on what we already fetched.
            if (sort) {
                const sortParts = sort.split('=');
                if (sortParts.length === 2 && sortParts[0] && sortParts[1]) {
                    const sortField = sortParts[0];
                    const sortOrder = sortParts[1].toLowerCase();
                    packageList.sort((a, b) => {
                        const aValue = (a as any)[sortField] ?? a.name;
                        const bValue = (b as any)[sortField] ?? b.name;
                        const comparison = String(aValue).localeCompare(
                            String(bValue),
                            undefined,
                            { sensitivity: 'base' }
                        );
                        return sortOrder === 'desc' ? -comparison : comparison;
                    });
                } else if (sortParts.length === 1 && sortParts[0]) {
                    // Allow `?sort=name` shorthand (ascending).
                    const sortField = sortParts[0];
                    packageList.sort((a, b) => {
                        const aValue = (a as any)[sortField] ?? a.name;
                        const bValue = (b as any)[sortField] ?? b.name;
                        return String(aValue).localeCompare(
                            String(bValue),
                            undefined,
                            { sensitivity: 'base' }
                        );
                    });
                }
            }

            for (const pkg of packageList) {
                packages[pkg.packageid] = pkg;
            }

            // Build pagination Link headers from Solr's authoritative count.
            const totalCount = searchResult.totalCount;
            if (totalCount > 0) {
                const linkHeaders: string[] = [];
                const queryParams = new URLSearchParams(req.query as Record<string, string>);

                if (offset > 0) {
                    queryParams.set('offset', '0');
                    queryParams.set('limit', limit.toString());
                    linkHeaders.push(
                        `<${baseUrl}${req.path}?${queryParams.toString()}>; rel="first"`
                    );

                    const prevOffset = Math.max(0, offset - limit);
                    queryParams.set('offset', prevOffset.toString());
                    linkHeaders.push(
                        `<${baseUrl}${req.path}?${queryParams.toString()}>; rel="prev"`
                    );
                }

                if (offset + limit < totalCount) {
                    queryParams.set('offset', (offset + limit).toString());
                    queryParams.set('limit', limit.toString());
                    linkHeaders.push(
                        `<${baseUrl}${req.path}?${queryParams.toString()}>; rel="next"`
                    );

                    const lastOffset = Math.floor((totalCount - 1) / limit) * limit;
                    queryParams.set('offset', lastOffset.toString());
                    linkHeaders.push(
                        `<${baseUrl}${req.path}?${queryParams.toString()}>; rel="last"`
                    );
                }

                linkHeaders.push(`count="${totalCount}"`);
                linkHeaders.push(`per-page="${limit}"`);

                res.setHeader('Link', linkHeaders.join(', '));
            }

            res.json(packages);
        })
    );

    /**
     * GET /javaregistries/:groupId/packages/:packageId - Get specific package
     */
    router.get(
        '/javaregistries/:groupId/packages/:packageId',
        asyncHandler(async (req: Request, res: Response) => {
            const { groupId, packageId } = req.params;
            if (!groupId || !packageId) {
                throw new Error('groupId and packageId are required');
            }
            const baseUrl = getBaseUrl(req);

            const pkg = await packageService.getPackage(groupId, packageId, baseUrl);
            res.json(pkg);
        })
    );

    /**
     * GET /javaregistries/:groupId/packages/:packageId/meta - Get package metadata
     */
    router.get(
        '/javaregistries/:groupId/packages/:packageId/meta',
        asyncHandler(async (req: Request, res: Response) => {
            const { groupId, packageId } = req.params;
            if (!groupId || !packageId) {
                throw new Error('groupId and packageId are required');
            }
            const baseUrl = getBaseUrl(req);

            const pkg = await packageService.getPackage(groupId, packageId, baseUrl);

            // Return minimal metadata
            res.json({
                xid: pkg.xid,
                self: pkg.self,
                epoch: pkg.epoch,
                createdat: pkg.createdat,
                modifiedat: pkg.modifiedat
            });
        })
    );

    /**
     * GET /javaregistries/:groupId/packages/:packageId/versions - List all versions
     */
    router.get(
        '/javaregistries/:groupId/packages/:packageId/versions',
        asyncHandler(async (req: Request, res: Response) => {
            const { groupId, packageId } = req.params;
            if (!groupId || !packageId) {
                throw new Error('groupId and packageId are required');
            }
            const baseUrl = getBaseUrl(req);

            // Parse pagination parameters
            const limit = parseInt(req.query['limit'] as string) || PAGINATION.DEFAULT_PAGE_LIMIT;
            const offset = parseInt(req.query['offset'] as string) || PAGINATION.DEFAULT_OFFSET;

            const result = await packageService.getPackageVersions(groupId, packageId, baseUrl, {
                limit,
                offset
            });

            res.json({
                versions: result.versions,
                count: Object.keys(result.versions).length,
                total: result.totalCount
            });
        })
    );

    /**
     * GET /javaregistries/:groupId/packages/:packageId/versions/:version - Get specific version
     */
    router.get(
        '/javaregistries/:groupId/packages/:packageId/versions/:version',
        asyncHandler(async (req: Request, res: Response) => {
            const { groupId, packageId, version } = req.params;
            if (!groupId || !packageId || !version) {
                throw new Error('groupId, packageId, and version are required');
            }
            const baseUrl = getBaseUrl(req);

            const versionData = await packageService.getVersion(groupId, packageId, version, baseUrl);
            res.json(versionData);
        })
    );

    /**
     * GET /javaregistries/:groupId/packages/:packageId/versions/:version/meta - Get version metadata
     */
    router.get(
        '/javaregistries/:groupId/packages/:packageId/versions/:version/meta',
        asyncHandler(async (req: Request, res: Response) => {
            const { groupId, packageId, version } = req.params;
            if (!groupId || !packageId || !version) {
                throw new Error('groupId, packageId, and version are required');
            }
            const baseUrl = getBaseUrl(req);

            const versionData = await packageService.getVersion(groupId, packageId, version, baseUrl);

            // Return minimal metadata
            res.json({
                xid: versionData.xid,
                self: versionData.self,
                versionid: versionData.versionid,
                epoch: versionData.epoch,
                createdat: versionData.createdat,
                modifiedat: versionData.modifiedat
            });
        })
    );

    return router;
}
