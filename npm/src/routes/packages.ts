/**
 * Package routes for the npm xRegistry wrapper.
 */

import { Request, Response, Router } from 'express';
import { RESOURCE_CONFIG } from '../config/constants';
import { asyncHandler } from '../middleware/xregistry-error-handler';
import { applyFilterFlag, applyInlineFlag, applySortFlag } from '../middleware/xregistry-flags';
import { PackageService } from '../services/package-service';

export interface PackageRouterOptions {
    packageService: PackageService;
}

export function createPackageRoutes(options: PackageRouterOptions): Router {
    const { packageService } = options;
    const router = Router();

    router.get(`/:nodescopeId/${RESOURCE_CONFIG.TYPE}`, asyncHandler(async (req: Request, res: Response): Promise<void> => {
        let { packages } = await packageService.getAllPackages({}, 0, 100);

        packages = packages.filter((pkg) => { const name = pkg.name || ''; return req.params['nodescopeId'] === (name.startsWith('@') ? name.slice(1, name.indexOf('/')) : '_'); });

        if (req.xregistryFlags?.filter) {
            packages = applyFilterFlag(packages, req.xregistryFlags.filter) as typeof packages;
        }
        if (req.xregistryFlags?.sort) {
            packages = applySortFlag(packages, req.xregistryFlags.sort) as typeof packages;
        }

        let responseData: Record<string, any> = {};
        packages.forEach((pkg) => {
            responseData[pkg.packageid] = pkg;
        });

        if (req.xregistryFlags?.inline) {
            responseData = applyInlineFlag(responseData, req.xregistryFlags.inline);
        }

        res.json(responseData);
    }));

    router.get(`/:nodescopeId/${RESOURCE_CONFIG.TYPE}/:packageId`, asyncHandler(async (req: Request, res: Response): Promise<void> => {
        let packageData = await packageService.getPackage(req.params['nodescopeId'] || '', req.params['packageId'] || '');
        if (req.xregistryFlags?.inline) {
            packageData = applyInlineFlag(packageData, req.xregistryFlags.inline) as typeof packageData;
        }
        res.json(packageData);
    }));

    router.get(`/:nodescopeId/${RESOURCE_CONFIG.TYPE}/:packageId/meta`, asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const metaData = await packageService.getPackageMeta(req.params['nodescopeId'] || '', req.params['packageId'] || '');
        res.json(metaData);
    }));

    return router;
}
