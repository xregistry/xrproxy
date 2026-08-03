/**
 * xRegistry Routes
 * @fileoverview Express routes implementing the xRegistry endpoints.
 */

import { NextFunction, Request, Response, Router } from 'express';
import { corsMiddleware } from '../middleware/cors';
import { errorHandler } from '../middleware/error-handler';
import { createLoggingMiddleware } from '../middleware/logging';
import { RegistryService } from '../services/registry-service';

export interface XRegistryRouterOptions {
    registryService: RegistryService;
    logger?: any;
}

export function createXRegistryRoutes(options: XRegistryRouterOptions): Router {
    const { registryService, logger } = options;
    const router = Router();

    router.use(corsMiddleware);
    if (logger) {
        router.use(createLoggingMiddleware({ logger }));
    }

    router.get('/', async (req: Request, res: Response, next: NextFunction) => {
        try {
            await registryService.getRegistry(req, res);
        } catch (error) {
            next(error);
        }
    });

    router.get('/nodescopes', async (req: Request, res: Response, next: NextFunction) => {
        try {
            await registryService.getGroups(req, res);
        } catch (error) {
            next(error);
        }
    });

    router.get('/nodescopes/:nodescopeId', async (req: Request, res: Response, next: NextFunction) => {
        try {
            await registryService.getGroup(req, res);
        } catch (error) {
            next(error);
        }
    });

    router.get('/nodescopes/:nodescopeId/packages', async (req: Request, res: Response, next: NextFunction) => {
        try {
            await registryService.getResources(req, res);
        } catch (error) {
            next(error);
        }
    });

    router.get('/nodescopes/:nodescopeId/packages/:packageId', async (req: Request, res: Response, next: NextFunction) => {
        try {
            await registryService.getResource(req, res);
        } catch (error) {
            next(error);
        }
    });

    router.use(errorHandler);
    return router;
}

export function createDefaultXRegistryRoutes(registryService: RegistryService, logger?: any): Router {
    return createXRegistryRoutes({ registryService, logger });
}
