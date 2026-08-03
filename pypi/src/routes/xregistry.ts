/**
 * xRegistry root and group routes.
 */

import { Request, Response, Router } from 'express';
import { getBaseUrl, REGISTRY_METADATA } from '../config/constants';
import { RegistryService } from '../services/registry-service';

export function createXRegistryRoutes(registryService: RegistryService): Router {
    const router = Router();
    const { GROUP_TYPE, GROUP_ID } = REGISTRY_METADATA;

    router.get('/', (req: Request, res: Response) => {
        const baseUrl = getBaseUrl(req);
        res.json(registryService.getRoot(baseUrl));
    });

    router.get('/model', (req: Request, res: Response) => {
        const baseUrl = getBaseUrl(req);
        res.json(registryService.getModel(baseUrl));
    });

    router.get('/capabilities', (_req: Request, res: Response) => {
        res.json(registryService.getCapabilities());
    });

    router.get('/export', (_req: Request, res: Response) => {
        res.redirect(302, '/?doc&inline=*,capabilities,modelsource');
    });

    router.get(`/${GROUP_TYPE}`, (req: Request, res: Response) => {
        const baseUrl = getBaseUrl(req);
        res.json(registryService.getGroups(baseUrl));
    });

    router.get(`/${GROUP_TYPE}/${GROUP_ID}`, (req: Request, res: Response) => {
        const baseUrl = getBaseUrl(req);
        res.json(registryService.getGroupDetails(baseUrl));
    });

    return router;
}
