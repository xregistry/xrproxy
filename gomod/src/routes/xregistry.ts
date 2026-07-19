/**
 * xRegistry root, model, capabilities, and group routes.
 */

import { Request, Response, Router } from 'express';
import { getBaseUrl, REGISTRY_METADATA, SERVER_CONFIG } from '../config/constants';
import { RegistryService } from '../services/registry-service';

const { GROUP_TYPE } = REGISTRY_METADATA;

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
        const limit = Math.min(
            parseInt(String(req.query['limit'] ?? SERVER_CONFIG.DEFAULT_PAGE_LIMIT), 10),
            SERVER_CONFIG.MAX_PAGE_LIMIT
        );
        const offset = Math.max(parseInt(String(req.query['offset'] ?? '0'), 10), 0);
        if (isNaN(limit) || limit <= 0) {
            res.status(400).json({ type: 'about:blank', title: 'limit must be > 0', status: 400, instance: req.originalUrl });
            return;
        }
        const { groups, totalCount } = registryService.getGroups(getBaseUrl(req), offset, limit);
        const nextOffset = offset + Object.keys(groups).length;
        res.setHeader('X-Total-Count', String(totalCount));
        if (nextOffset < totalCount) {
            res.setHeader(
                'Link',
                `<${getBaseUrl(req)}/${GROUP_TYPE}?offset=${nextOffset}&limit=${limit}>; rel="next"`
            );
        }
        res.json(groups);
    });

    router.get(`/${GROUP_TYPE}/:groupId`, (req: Request, res: Response) => {
        const groupId = req.params['groupId'];
        if (typeof groupId !== 'string' || groupId.length === 0) {
            res.status(400).json({ type: 'about:blank', title: 'groupId is required', status: 400, instance: req.originalUrl });
            return;
        }
        res.json(registryService.getGroup(getBaseUrl(req), groupId));
    });

    return router;
}
