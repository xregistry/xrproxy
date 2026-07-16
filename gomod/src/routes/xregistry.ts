/**
 * xRegistry root, model, capabilities, and group routes.
 */

import { Request, Response, Router } from 'express';
import { getBaseUrl, REGISTRY_METADATA } from '../config/constants';
import { RegistryService } from '../services/registry-service';

const { GROUP_TYPE, GROUP_ID } = REGISTRY_METADATA;

export function createXRegistryRoutes(registryService: RegistryService): Router {
    const router = Router();

    router.get('/', (req: Request, res: Response) => {
        res.json(registryService.getRoot(getBaseUrl(req)));
    });

    router.get('/model', (req: Request, res: Response) => {
        res.json(registryService.getModel(getBaseUrl(req)));
    });

    router.get('/capabilities', (_req: Request, res: Response) => {
        res.json(registryService.getCapabilities());
    });

    router.get('/export', (_req: Request, res: Response) => {
        res.redirect(302, '/?doc&inline=*,capabilities,modelsource');
    });

    router.get(`/${GROUP_TYPE}`, (req: Request, res: Response) => {
        res.json(registryService.getGroups(getBaseUrl(req)));
    });

    router.get(`/${GROUP_TYPE}/${GROUP_ID}`, (req: Request, res: Response) => {
        res.json(registryService.getGroup(getBaseUrl(req)));
    });

    return router;
}
