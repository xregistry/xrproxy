/**
 * xRegistry Routes
 * @fileoverview Root xRegistry endpoints for Maven wrapper
 */

import { Request, Response, Router } from 'express';
import { asyncHandler } from '../middleware/xregistry-error-handler';
import { RegistryService } from '../services/registry-service';

export interface XRegistryRoutesOptions {
    registryService: RegistryService;
}

export function createXRegistryRoutes(options: XRegistryRoutesOptions): Router {
    const router = Router();
    const { registryService } = options;

    router.get('/', asyncHandler(async (req: Request, res: Response) => {
        await registryService.getRegistry(req, res);
    }));

    router.get('/model', asyncHandler(async (req: Request, res: Response) => {
        await registryService.getModel(req, res);
    }));

    router.get('/capabilities', asyncHandler(async (req: Request, res: Response) => {
        await registryService.getCapabilities(req, res);
    }));

    router.get('/export', (_req: Request, res: Response) => {
        res.redirect(302, '/?doc&inline=*,capabilities,modelsource');
    });

    router.get('/javanamespaces', asyncHandler(async (req: Request, res: Response) => {
        await registryService.getGroups(req, res);
    }));

    router.get('/javanamespaces/:groupId', asyncHandler(async (req: Request, res: Response) => {
        await registryService.getGroup(req, res);
    }));

    return router;
}
