/**
 * xRegistry static route handlers
 * Handles root, model, capabilities, registries, health, and status endpoints
 */

import axios from 'axios';
import { Request, Response, Router } from 'express';
import { BASE_URL, BRIDGE_EPOCH, BRIDGE_STARTUP_TIME, getBaseUrl, getApiBaseUrl } from '../config/constants';
import { DownstreamService } from '../services/downstream-service';
import { HealthService } from '../services/health-service';
import { ModelService } from '../services/model-service';

export function createXRegistryRoutes(
    modelService: ModelService,
    healthService: HealthService,
    downstreamService: DownstreamService,
    logger: any
): Router {
    const router = Router();

    // Root endpoint with inline support
    router.get('/', async (req: Request, res: Response) => {
        try {
            // Handle query parameters
            const inline = req.query.inline as string;
            const specversion = (req.query.specversion as string) || '1.0-rc2';

            // Get the actual base URL from the request (with API path prefix)
            const apiBaseUrl = getApiBaseUrl(req);

            logger.info('Root endpoint called', {
                configuredBaseUrl: BASE_URL,
                actualApiBaseUrl: apiBaseUrl,
                requestHost: req.get('host'),
                requestUrl: req.url,
                requestProtocol: req.protocol,
                originalUrl: req.originalUrl
            });

            // Check if requested specversion is supported
            if (specversion !== '1.0-rc2' && specversion !== '1.0-rc1' && specversion !== '1.0') {
                return res.status(400).json({
                    type: 'https://github.com/xregistry/spec/blob/main/core/spec.md#bad_flag',
                    title: `The specified specversion (${specversion}) is not supported.`,
                    status: 400,
                    detail: 'Supported versions: 1.0-rc2 (preferred), 1.0-rc1, 1.0',
                    subject: req.originalUrl
                });
            }

            const now = new Date().toISOString();
            const groups = modelService.getAvailableGroups();
            const consolidatedModel = modelService.getConsolidatedModel();
            const consolidatedCapabilities = modelService.getConsolidatedCapabilities();
            const groupTypeToBackend = modelService.getGroupTypeToBackend();
            const serverStates = downstreamService.getServerStates();

            // Build the base registry response according to xRegistry spec
            const registryResponse: any = {
                specversion: specversion,
                registryid: 'xregistry-bridge',
                self: apiBaseUrl,
                xid: '/',
                epoch: BRIDGE_EPOCH,
                name: 'xRegistry Bridge',
                description: 'Unified xRegistry bridge for multiple package registry backends',
                createdat: BRIDGE_STARTUP_TIME,
                modifiedat: now
            };

            // Add group collections (REQUIRED)
            for (const groupType of groups) {
                const plural = consolidatedModel.groups?.[groupType]?.plural || groupType;
                registryResponse[`${plural}url`] = `${apiBaseUrl}/${groupType}`;

                // Get count from the server state that holds this registry
                const backendServer = groupTypeToBackend[groupType];
                const serverState = backendServer ? serverStates.get(backendServer.url) : undefined;

                // Default to 1 for known registry types
                let defaultCount = 0;
                if (['javaregistries', 'dotnetregistries', 'noderegistries', 'pythonregistries', 'containerregistries'].includes(groupType)) {
                    defaultCount = 1;
                }

                if (serverState?.isActive && serverState.model?.groups?.[groupType]?.plural) {
                    const serverPlural = serverState.model.groups[groupType].plural;
                    const countKey = `${serverPlural}count`;
                    const serverCount = serverState.model[countKey] !== undefined ? serverState.model[countKey] : 0;
                    registryResponse[`${plural}count`] = serverCount > 0 ? serverCount : defaultCount;
                } else {
                    registryResponse[`${plural}count`] = defaultCount;
                }
            }

            // Handle inline parameters per core spec §"Inline Flag".
            //
            //   - inline=*           => inline every nested collection but
            //                          NOT model/modelsource/capabilities
            //   - inline=model       => embed the consolidated model
            //   - inline=capabilities=> embed the capabilities object
            //   - inline=<plural>    => inline a single group's collection
            //   - inline=<plural>.*  => deep inline; we forward the
            //                          remainder of the path to the downstream
            //                          so it can apply the same flag locally
            //
            // The previous implementation only matched literal `model`,
            // `capabilities`, and `<plural>` entries, silently dropping
            // `*` and any nested path. Fixed here.
            if (inline) {
                const inlineRequests = inline.split(',').map(s => s.trim()).filter(Boolean);
                const wantsAll = inlineRequests.includes('*');
                const wantsModel = inlineRequests.includes('model') || inlineRequests.includes('model,*');
                const wantsCapabilities = inlineRequests.includes('capabilities');

                if (wantsModel) {
                    registryResponse.model = consolidatedModel;
                }
                if (wantsCapabilities) {
                    registryResponse.capabilities = consolidatedCapabilities;
                }

                // Walk each declared group and decide whether the client asked
                // for it directly (`?inline=noderegistries`), via `*`, or via
                // a nested path (`?inline=noderegistries.packages`).
                for (const groupType of groups) {
                    const plural = consolidatedModel.groups?.[groupType]?.plural || groupType;
                    const nestedPath = inlineRequests.find(p => p === plural || p.startsWith(`${plural}.`));
                    const shouldInline = wantsAll || !!nestedPath;
                    if (!shouldInline) continue;

                    const backendServer = groupTypeToBackend[groupType];
                    if (!backendServer) {
                        registryResponse[plural] = {};
                        continue;
                    }

                    try {
                        const headers: Record<string, string> = {};
                        if (backendServer.apiKey) {
                            headers['Authorization'] = `Bearer ${backendServer.apiKey}`;
                        }

                        // Build the downstream request. For nested paths we
                        // strip the leading group component and forward the
                        // remainder as the downstream's own `inline` flag so
                        // packages/versions get materialised at source.
                        let downstreamUrl = `${backendServer.url}/${groupType}`;
                        if (nestedPath && nestedPath !== plural) {
                            const remainder = nestedPath.substring(plural.length + 1);
                            downstreamUrl += `?inline=${encodeURIComponent(remainder)}`;
                        } else if (wantsAll && !nestedPath) {
                            // Top-level `*` cascades down per spec.
                            downstreamUrl += `?inline=*`;
                        }

                        const groupResponse = await axios.get(downstreamUrl, {
                            headers,
                            timeout: 30000
                        });
                        registryResponse[plural] = groupResponse.data;

                        logger.debug('Inlined group collection', {
                            groupType,
                            plural,
                            downstreamUrl
                        });
                    } catch (error) {
                        logger.error('Failed to fetch group collection for inlining', {
                            groupType,
                            plural,
                            backendUrl: backendServer.url,
                            error: error instanceof Error ? error.message : String(error)
                        });
                        registryResponse[plural] = {};
                    }
                }
            }

            return res.json(registryResponse);
        } catch (error) {
            logger.error('Error in root endpoint', {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined
            });
            return res.status(500).json({
                type: 'https://github.com/xregistry/spec/blob/main/core/spec.md#server_error',
                title: 'Internal Server Error',
                status: 500,
                detail: 'An unexpected error occurred while building the registry root response.',
                instance: req.originalUrl
            });
        }
    });

    // Export endpoint - shorthand for inlining everything plus model and
    // capabilities. Per core spec §"Inline Flag", `*` alone excludes those
    // three, so the canonical export URL adds them explicitly.
    router.get('/export', (req: Request, res: Response) => {
        const apiBaseUrl = getApiBaseUrl(req);
        return res.redirect(302, `${apiBaseUrl}/?inline=*,model,capabilities`);
    });

    // Model endpoint
    router.get('/model', (_req: Request, res: Response) => {
        try {
            res.json(modelService.getConsolidatedModel());
        } catch (error) {
            logger.error('Error in model endpoint', {
                error: error instanceof Error ? error.message : String(error)
            });
            res.status(500).json({ error: 'Internal Server Error' });
        }
    });

    // Capabilities endpoint
    router.get('/capabilities', (_req: Request, res: Response) => {
        try {
            res.json(modelService.getConsolidatedCapabilities());
        } catch (error) {
            logger.error('Error in capabilities endpoint', {
                error: error instanceof Error ? error.message : String(error)
            });
            res.status(500).json({ error: 'Internal Server Error' });
        }
    });

    // Registries endpoint - returns the groups from consolidated model
    router.get('/registries', (_req: Request, res: Response) => {
        try {
            const consolidatedModel = modelService.getConsolidatedModel();
            res.json(consolidatedModel.groups || {});
        } catch (error) {
            logger.error('Error in registries endpoint', {
                error: error instanceof Error ? error.message : String(error)
            });
            res.status(500).json({ error: 'Internal Server Error' });
        }
    });

    // Health endpoint
    router.get('/health', async (_req: Request, res: Response) => {
        try {
            const health = await healthService.getHealth();
            res.status(health.status === 'healthy' ? 200 : 503).json(health);
        } catch (error) {
            logger.error('Error in health endpoint', {
                error: error instanceof Error ? error.message : String(error)
            });
            res.status(500).json({ error: 'Internal Server Error' });
        }
    });

    // Status endpoint for detailed server information
    router.get('/status', (_req: Request, res: Response) => {
        try {
            const status = healthService.getStatus();
            res.json(status);
        } catch (error) {
            logger.error('Error in status endpoint', {
                error: error instanceof Error ? error.message : String(error)
            });
            res.status(500).json({ error: 'Internal Server Error' });
        }
    });

    return router;
}
