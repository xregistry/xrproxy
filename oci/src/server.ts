import express, { Application, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { EntityStateManager } from '../../shared/entity-state-manager';
import { GROUP_CONFIG, RESOURCE_CONFIG, SERVER_CONFIG } from './config/constants';
import { parseXRegistryFlags } from './middleware/xregistry-flags';
import { OCIService, OCIServiceConfig } from './services/oci-service';
import { ImageService } from './services/image-service';
import { RegistryService } from './services/registry-service';
import { OCIBackend } from './types/oci';
import { XRegistryError, apiNotFound, errorToXRegistryError } from './utils/xregistry-errors';

class Logger {
    info(message: string, data?: unknown): void {
        console.log(`[INFO] ${message}`, data ? JSON.stringify(data) : '');
    }

    error(message: string, data?: unknown): void {
        console.error(`[ERROR] ${message}`, data ? JSON.stringify(data) : '');
    }

    warn(message: string, data?: unknown): void {
        console.warn(`[WARN] ${message}`, data ? JSON.stringify(data) : '');
    }
}

export interface ServerOptions {
    port?: number;
    host?: string;
    backends?: OCIBackend[];
    cacheDir?: string;
}

export class OCIXRegistryServer {
    private readonly app: Application;
    private readonly ociService: OCIService;
    private readonly imageService: ImageService;
    private readonly registryService: RegistryService;
    private readonly logger: Logger;
    private readonly port: number;
    private readonly host: string;

    constructor(options: ServerOptions = {}) {
        this.logger = new Logger();
        this.port = options.port || SERVER_CONFIG.DEFAULT_PORT;
        this.host = options.host || SERVER_CONFIG.DEFAULT_HOST;
        this.app = express();

        const backends = this.loadBackends(options.backends);
        const entityState = new EntityStateManager();
        const baseUrl = `http://localhost:${this.port}`;
        const ociServiceConfig: OCIServiceConfig = {
            backends,
            baseUrl,
            entityState,
            ...(options.cacheDir ? { cacheDir: options.cacheDir } : {}),
        };

        this.ociService = new OCIService(ociServiceConfig);
        this.imageService = new ImageService({ ociService: this.ociService, baseUrl }, entityState);
        this.registryService = new RegistryService({ imageService: this.imageService, logger: this.logger }, entityState);

        this.setupMiddleware();
        this.setupRoutes();
        this.setupErrorHandling();
    }

    private loadBackends(providedBackends?: OCIBackend[]): OCIBackend[] {
        if (providedBackends) {
            return providedBackends;
        }

        const backendsPath = path.join(process.cwd(), 'backends.json');
        if (fs.existsSync(backendsPath)) {
            try {
                const backendsData = JSON.parse(fs.readFileSync(backendsPath, 'utf8')) as { backends?: OCIBackend[] };
                if (Array.isArray(backendsData.backends)) {
                    return backendsData.backends.map((backend) => {
                        const enrichedBackend: OCIBackend = { ...backend };
                        if (backend.id === 'docker.io') {
                            if (process.env.DOCKER_USERNAME) {
                                enrichedBackend.username = process.env.DOCKER_USERNAME;
                            }
                            if (process.env.DOCKER_PASSWORD) {
                                enrichedBackend.password = process.env.DOCKER_PASSWORD;
                            }
                        }
                        if (backend.id === 'ghcr.io' && process.env.GHCR_TOKEN) {
                            enrichedBackend.username = 'oauth2';
                            enrichedBackend.password = process.env.GHCR_TOKEN;
                        }
                        return enrichedBackend;
                    });
                }
            } catch (error) {
                this.logger.warn('Failed to load backends.json, using defaults', error);
            }
        }

        return [{
            id: 'mcr.microsoft.com',
            name: 'Microsoft Container Registry',
            url: 'https://mcr.microsoft.com',
            apiVersion: 'v2',
            description: 'Microsoft Container Registry',
            enabled: true,
            public: true,
            catalogPath: '/v2/_catalog',
        }];
    }

    private setupMiddleware(): void {
        this.app.use((_req, res, next) => {
            res.header('Access-Control-Allow-Origin', '*');
            res.header('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
            res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
            next();
        });
        this.app.use(express.json());
        this.app.use(express.urlencoded({ extended: true }));
        this.app.use(parseXRegistryFlags);
    }

    private setupRoutes(): void {
        this.app.get('/health', (_req: Request, res: Response) => {
            res.json({
                status: 'healthy',
                service: 'oci-xregistry-wrapper',
                timestamp: new Date().toISOString(),
                backends: this.ociService.getBackends().map((backend) => ({
                    id: backend.id,
                    name: backend.name,
                    enabled: backend.enabled,
                })),
            });
        });

        this.app.get('/', (req: Request, res: Response) => {
            void this.registryService.getRegistry(req, res);
        });
        this.app.get('/model', (req: Request, res: Response) => {
            void this.registryService.getModel(req, res);
        });
        this.app.get('/capabilities', (req: Request, res: Response) => {
            void this.registryService.getCapabilities(req, res);
        });
        this.app.get(`/${GROUP_CONFIG.TYPE}`, (req: Request, res: Response) => {
            void this.registryService.getGroups(req, res);
        });
        this.app.get(`/${GROUP_CONFIG.TYPE}/:groupId`, (req: Request, res: Response) => {
            void this.registryService.getGroup(req, res);
        });
        this.app.get(`/${GROUP_CONFIG.TYPE}/:groupId/${RESOURCE_CONFIG.TYPE}`, (req: Request, res: Response) => {
            void this.registryService.getResources(req, res);
        });
        this.app.get(`/${GROUP_CONFIG.TYPE}/:groupId/${RESOURCE_CONFIG.TYPE}/:resourceId`, (req: Request, res: Response) => {
            void this.registryService.getResource(req, res);
        });
        this.app.get(`/${GROUP_CONFIG.TYPE}/:groupId/${RESOURCE_CONFIG.TYPE}/:resourceId/meta`, (req: Request, res: Response) => {
            void this.registryService.getMeta(req, res);
        });
        this.app.get(`/${GROUP_CONFIG.TYPE}/:groupId/${RESOURCE_CONFIG.TYPE}/:resourceId/versions`, (req: Request, res: Response) => {
            void this.registryService.getVersions(req, res);
        });
        this.app.get(`/${GROUP_CONFIG.TYPE}/:groupId/${RESOURCE_CONFIG.TYPE}/:resourceId/versions/:versionId`, (req: Request, res: Response) => {
            void this.registryService.getVersion(req, res);
        });
    }

    private setupErrorHandling(): void {
        this.app.all('*', (req: Request, res: Response, next) => {
            if (['PUT', 'PATCH', 'POST', 'DELETE'].includes(req.method)) {
                res.status(405).json({
                    type: 'about:blank',
                    title: 'Method Not Allowed',
                    status: 405,
                    detail: `${req.method} method not supported on ${req.path}`,
                    instance: req.path,
                });
                return;
            }
            next();
        });

        this.app.use((req: Request, res: Response) => {
            const error: XRegistryError = apiNotFound(req.originalUrl || req.path, `${req.method} ${req.path}`);
            res.status(error.status).json(error);
        });

        this.app.use((err: Error, req: Request, res: Response, _next: unknown) => {
            const xError = errorToXRegistryError(err, req.originalUrl || req.path);
            res.status(xError.status).json(xError);
        });
    }

    public async start(): Promise<void> {
        await new Promise<void>((resolve) => {
            this.app.listen(this.port, this.host, () => {
                this.logger.info('OCI xRegistry Wrapper started', {
                    port: this.port,
                    host: this.host,
                    groupType: GROUP_CONFIG.TYPE,
                    resourceType: RESOURCE_CONFIG.TYPE,
                });
                resolve();
            });
        });
    }

    public getApp(): Application {
        return this.app;
    }
}

if (require.main === module) {
    const args = process.argv.slice(2);
    let port = process.env.PORT ? parseInt(process.env.PORT, 10) : SERVER_CONFIG.DEFAULT_PORT;
    let host = process.env.HOST || SERVER_CONFIG.DEFAULT_HOST;

    for (let index = 0; index < args.length; index += 1) {
        if (args[index] === '--port' && args[index + 1]) {
            port = parseInt(args[index + 1] as string, 10);
        }
        if (args[index] === '--host' && args[index + 1]) {
            host = args[index + 1] as string;
        }
    }

    const server = new OCIXRegistryServer({ port, host });
    void server.start().catch((error) => {
        console.error('Failed to start server:', error);
        process.exit(1);
    });

    process.on('SIGTERM', () => process.exit(0));
    process.on('SIGINT', () => process.exit(0));
}

export default OCIXRegistryServer;
