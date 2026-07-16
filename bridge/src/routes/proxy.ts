/**
 * Dynamic proxy routes setup
 * Sets up proxy middleware for each available group type
 */

import { Express } from 'express';
import { ModelService } from '../services/model-service';
import { ProxyService } from '../services/proxy-service';

const configuredApps = new WeakSet<object>();

/**
 * Setup dynamic proxy routes for all available group types
 */
export function setupDynamicProxyRoutes(
    app: Express,
    modelService: ModelService,
    proxyService: ProxyService,
    logger: any,
    pathPrefix: string = ''
): void {
    try {
        if (configuredApps.has(app as object)) {
            logger.debug('Dynamic proxy dispatcher already configured');
            return;
        }
        configuredApps.add(app as object);

        const basePath = pathPrefix ? `${pathPrefix}/:groupType` : '/:groupType';
        const middlewareCache = new Map<string, ReturnType<ProxyService['createProxyMiddleware']>>();

        logger.info('Setting up dynamic route dispatcher', { basePath });
        app.use(basePath, (req, res, next) => {
            const groupType = req.params.groupType;
            const backend = modelService.getBackendForGroup(groupType);
            if (!backend) {
                return next();
            }

            const cacheKey = `${groupType}\n${backend.url}\n${backend.apiKey || ''}`;
            let middlewares = middlewareCache.get(cacheKey);
            if (!middlewares) {
                middlewares = proxyService.createProxyMiddleware(groupType, backend);
                middlewareCache.set(cacheKey, middlewares);
            }

            let index = 0;
            const run = (error?: any): void => {
                if (error) {
                    next(error);
                    return;
                }
                const middleware = middlewares![index++];
                if (!middleware) {
                    next();
                    return;
                }
                middleware(req, res, run);
            };
            run();
        });
    } catch (error) {
        logger.error('Critical error in setupDynamicProxyRoutes', {
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined
        });
    }
}
