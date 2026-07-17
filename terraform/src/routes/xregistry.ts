/**
 * xRegistry group and export routes
 * /terraformregistries and /export endpoints.
 * NOTE: /model, /capabilities, /health, /ready are handled by createRegistryApp.
 */

import { Request, Response, Router } from 'express';
import { getBaseUrl, REGISTRY_METADATA } from '../config/constants';
import { RegistryService } from '../services/registry-service';

export function createXRegistryRoutes(registryService: RegistryService): Router {
    const router = Router();
    const { GROUP_TYPE, GROUP_ID } = REGISTRY_METADATA;

    router.get('/', (req: Request, res: Response) => {
        res.json(registryService.getRoot(getBaseUrl(req)));
    });

    router.get('/export', (_req: Request, res: Response) => {
        res.redirect(302, '/?doc&inline=*,capabilities,modelsource');
    });

    router.get(`/${GROUP_TYPE}`, (req: Request, res: Response) => {
        res.json(registryService.getGroups(getBaseUrl(req)));
    });

    router.get(`/${GROUP_TYPE}/${GROUP_ID}`, (req: Request, res: Response) => {
        res.json(registryService.getGroupDetails(getBaseUrl(req)));
    });

    return router;
}
