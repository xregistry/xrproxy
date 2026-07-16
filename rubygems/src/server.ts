import { createRegistryApp, listenWithGracefulShutdown, parseConfig, ConfigSchema } from '@xregistry/registry-core';
import { join } from 'node:path';
import modelData from '../model.json';
import { GROUP_CONFIG, REGISTRY_CONFIG, RESOURCE_CONFIG } from './config/constants';
import { createCorsMiddleware } from './middleware/cors';
import { createLoggingMiddleware } from './middleware/logging';
import { xregistryErrorHandler } from './middleware/xregistry-error-handler';
import { parseXRegistryFlags } from './middleware/xregistry-flags';
import { createPackageRoutes } from './routes/packages';
import { RegistryService } from './services/registry-service';
import { RubyGemsService } from './services/rubygems-service';
import { ProblemDetailsError } from './utils/xregistry-errors';

const RUBYGEMS_CONFIG_SCHEMA = {
    HOST: { type: 'string', default: '0.0.0.0', minLength: 1 },
    PORT: { type: 'integer', default: 4000, min: 1, max: 65535 },
} as const satisfies ConfigSchema;

async function main(): Promise<void> {
    const config = parseConfig(RUBYGEMS_CONFIG_SCHEMA);
    const cacheDir = join(process.cwd(), 'cache');
    const rubygemsService = new RubyGemsService({ cacheDir });
    const registryService = new RegistryService(rubygemsService);

    const capabilities = {
        specversion: REGISTRY_CONFIG.SPEC_VERSION,
        registryid: REGISTRY_CONFIG.ID,
        groups: {
            [GROUP_CONFIG.TYPE]: {
                resources: [RESOURCE_CONFIG.TYPE],
            },
        },
    };

    const app = createRegistryApp({
        model: modelData,
        capabilities,
        errorResponse: (error: unknown) => {
            if (error instanceof ProblemDetailsError) {
                return {
                    status: error.status,
                    body: {
                        type: error.type,
                        title: error.title,
                        status: error.status,
                        instance: error.instance,
                        ...(error.detail !== undefined ? { detail: error.detail } : {}),
                    },
                };
            }
            return {
                status: 500,
                body: {
                    type: 'about:blank',
                    title: 'Internal Server Error',
                    status: 500,
                    detail: error instanceof Error ? error.message : 'An unexpected error occurred.',
                },
            };
        },
        configure: (express) => {
            express.use(createCorsMiddleware());
            express.use(createLoggingMiddleware());
            express.use(parseXRegistryFlags);

            express.get('/', async (req, res, next) => {
                try { await registryService.getRegistry(req, res); } catch (err) { next(err); }
            });
            express.get(`/${GROUP_CONFIG.TYPE}`, async (req, res, next) => {
                try { await registryService.getGroups(req, res); } catch (err) { next(err); }
            });
            express.get(`/${GROUP_CONFIG.TYPE}/:groupId`, async (req, res, next) => {
                try { await registryService.getGroup(req, res); } catch (err) { next(err); }
            });

            express.use('/', createPackageRoutes(registryService));
            express.use(xregistryErrorHandler);
        },
    });

    const { server } = await listenWithGracefulShutdown(app, {
        host: config.HOST,
        port: config.PORT,
        shutdownTimeoutMs: 5_000,
    });

    const addr = server.address();
    const port = addr && typeof addr === 'object' ? addr.port : config.PORT;
    console.log(`[INFO] RubyGems xRegistry proxy listening on http://${config.HOST}:${port}`);
}

void main();
