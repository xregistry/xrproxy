import { Request, Response, Router } from 'express';
import { GROUP_CONFIG, RESOURCE_CONFIG } from '../config/constants';
import { asyncHandler } from '../middleware/xregistry-error-handler';
import { RegistryService } from '../services/registry-service';

export function createPackageRoutes(registryService: RegistryService): Router {
    const router = Router();

    router.get(`/${GROUP_CONFIG.TYPE}/:groupId/${RESOURCE_CONFIG.TYPE}`, asyncHandler(async (req: Request, res: Response) => {
        await registryService.getResources(req, res);
    }));

    router.get(`/${GROUP_CONFIG.TYPE}/:groupId/${RESOURCE_CONFIG.TYPE}/:name`, asyncHandler(async (req: Request, res: Response) => {
        await registryService.getResource(req, res);
    }));

    router.get(`/${GROUP_CONFIG.TYPE}/:groupId/${RESOURCE_CONFIG.TYPE}/:name/meta`, asyncHandler(async (req: Request, res: Response) => {
        await registryService.getMeta(req, res);
    }));

    router.get(`/${GROUP_CONFIG.TYPE}/:groupId/${RESOURCE_CONFIG.TYPE}/:name/versions`, asyncHandler(async (req: Request, res: Response) => {
        await registryService.getVersions(req, res);
    }));

    router.get(`/${GROUP_CONFIG.TYPE}/:groupId/${RESOURCE_CONFIG.TYPE}/:name/versions/:versionId`, asyncHandler(async (req: Request, res: Response) => {
        await registryService.getVersion(req, res);
    }));

    return router;
}
