/**
 * xRegistry MCP Wrapper Server
 * @fileoverview Service for MCP servers
 */

import axios from 'axios';
import express from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { HTTP_STATUS, MCP_REGISTRY, PAGINATION, REGISTRY_CONFIG, SERVER_CONFIG, getBaseUrl } from './config/constants';
import { corsMiddleware } from './middleware/cors';
import { MCPService } from './services/mcp-service';
import { MCPServerResponse } from './types/mcp';
import { PaginatedResponse, ProviderMetadata, RegistryMetadata, ServerMetadata, ServerResourceMeta, ServerVersionMetadata } from './types/xregistry';

// Simple console logger
class SimpleLogger {
    info(message: string, data?: any) {
        console.log(`[INFO] ${message}`, data ? JSON.stringify(data, null, 2) : '');
    }
    error(message: string, data?: any) {
        console.error(`[ERROR] ${message}`, data ? JSON.stringify(data, null, 2) : '');
    }
    warn(message: string, data?: any) {
        console.warn(`[WARN] ${message}`, data ? JSON.stringify(data, null, 2) : '');
    }
    debug(message: string, data?: any) {
        console.debug(`[DEBUG] ${message}`, data ? JSON.stringify(data, null, 2) : '');
    }
}

export interface ServerOptions {
    port?: number;
    host?: string;
    mcpRegistryUrl?: string;
    cacheEnabled?: boolean;
    cacheTtl?: number;
    upstreamTimeout?: number;
    logLevel?: string;
    baseUrl?: string;
}

export class XRegistryServer {
    private app: express.Application;
    private server: any;
    private mcpService!: MCPService;
    private logger!: SimpleLogger;
    private options: Required<ServerOptions>;
    private model: any;

    // In-memory cache for grouped servers with TTL
    private cachedGroupedServers: Map<string, MCPServerResponse[]> | null = null;
    private cacheTimestamp: number = 0;
    // In-flight refresh promise. Used both for de-duplicating concurrent
    // misses and for stale-while-revalidate so a refresh never blocks the
    // request that triggered it once we have any cached data.
    private inflightRefresh: Promise<Map<string, MCPServerResponse[]>> | null = null;

    constructor(options: ServerOptions = {}) {
        this.options = {
            port: options.port || SERVER_CONFIG.DEFAULT_PORT,
            host: options.host || SERVER_CONFIG.DEFAULT_HOST,
            mcpRegistryUrl: options.mcpRegistryUrl || 'https://registry.modelcontextprotocol.io',
            cacheEnabled: options.cacheEnabled !== false,
            cacheTtl: options.cacheTtl || 86400000,
            upstreamTimeout: options.upstreamTimeout || MCP_REGISTRY.TIMEOUT_MS,
            logLevel: options.logLevel || 'info',
            baseUrl: options.baseUrl || `http://localhost:${options.port || SERVER_CONFIG.DEFAULT_PORT}`
        };

        this.logger = new SimpleLogger();
        this.app = express();
        this.loadModel();
        this.initializeServices();
        this.setupMiddleware();
        this.setupRoutes();
        this.setupErrorHandling();
    }

    /**
     * Load model.json
     */
    private loadModel(): void {
        const modelPath = path.join(__dirname, '../model.json');
        try {
            this.model = JSON.parse(fs.readFileSync(modelPath, 'utf8'));
        } catch (error) {
            this.logger.error('Failed to load model.json', error);
            throw error;
        }
    }

    /**
     * Initialize services
     */
    private initializeServices(): void {
        // Initialize MCP service
        this.mcpService = new MCPService({
            baseUrl: this.options.mcpRegistryUrl,
            cacheTtl: this.options.cacheTtl,
            timeout: this.options.upstreamTimeout
        });
    }

    /**
     * Setup middleware
     */
    private setupMiddleware(): void {
        this.app.use(corsMiddleware);
        this.app.use(express.json());
    }

    /**
     * Setup routes
     */
    private setupRoutes(): void {
        // Health check - mirrors the shape of the other downstreams so the
        // bridge's per-downstream /health probe gets a 2xx instead of 404.
        this.app.get('/health', (_req, res) => {
            res.json({
                status: 'healthy',
                timestamp: new Date().toISOString(),
                version: process.env['npm_package_version'] || '1.0.0',
                uptime: process.uptime()
            });
        });

        // Root - Registry entity
        this.app.get('/', async (req, res) => {
            try {
                const inline = req.query.inline as string;
                const registry = await this.getRegistryEntity(req, inline);
                res.json(registry);
            } catch (error) {
                this.handleError(res, error);
            }
        });

        // Model endpoint
        this.app.get('/model', (req, res) => {
            try {
                // Return the full model.json content
                res.json(this.model);
            } catch (error) {
                this.handleError(res, error);
            }
        });

        // Capabilities endpoint
        this.app.get('/capabilities', (req, res) => {
            try {
                // Per core spec §"Design: JSON Serialization": `apis` is the
                // list of optional endpoints we implement (not a wire-format
                // identifier), `mutable` is an array of mutable areas, and
                // feature flag names belong inside `flags`.
                res.json({
                    apis: ['/capabilities', '/model', '/export'],
                    flags: ['doc', 'epoch', 'filter', 'inline', 'sort', 'specversion'],
                    formats: ['xRegistry-json/1.0-rc2'],
                    mutable: [],
                    pagination: true,
                    specversions: ['1.0-rc2']
                });
            } catch (error) {
                this.handleError(res, error);
            }
        });

        // MCP Providers collection
        this.app.get('/mcpproviders', async (req, res) => {
            try {
                const inline = req.query.inline as string;
                const limit = req.query.limit ? parseInt(req.query.limit as string) : undefined;
                const offset = req.query.offset ? parseInt(req.query.offset as string) : 0;

                const result = await this.getMCPProviders(req, inline, limit, offset);

                // Add pagination Link headers if applicable
                if (result.links) {
                    for (const link of result.links) {
                        res.append('Link', link);
                    }
                }

                res.json(result.data);
            } catch (error) {
                this.handleError(res, error);
            }
        });

        // Specific MCP Provider
        this.app.get('/mcpproviders/:providerId', async (req, res) => {
            try {
                const { providerId } = req.params;
                const inline = req.query.inline as string;
                const provider = await this.getMCPProvider(req, providerId, inline);

                if (!provider) {
                    res.status(HTTP_STATUS.NOT_FOUND).json({
                        error: 'Provider not found'
                    });
                    return;
                }

                res.json(provider);
            } catch (error) {
                this.handleError(res, error);
            }
        });

        // Servers collection within a provider
        this.app.get('/mcpproviders/:providerId/servers', async (req, res) => {
            try {
                const { providerId } = req.params;
                const limit = req.query.limit ? parseInt(req.query.limit as string) : undefined;
                const offset = req.query.offset ? parseInt(req.query.offset as string) : 0;

                const result = await this.getServersForProvider(req, providerId, limit, offset);

                // Add pagination Link headers if applicable
                if (result.links) {
                    for (const link of result.links) {
                        res.append('Link', link);
                    }
                }

                res.json(result.data);
            } catch (error) {
                this.handleError(res, error);
            }
        });

        // Specific server (returns latest version or versions collection)
        this.app.get('/mcpproviders/:providerId/servers/:serverId', async (req, res) => {
            try {
                const { providerId, serverId } = req.params;
                const inline = req.query.inline as string;

                // Check if versions should be inlined
                const shouldInlineVersions = inline ? (inline === '*' || inline.includes('versions')) : false;

                const server = await this.getServerWithVersions(req, providerId, serverId, shouldInlineVersions);

                if (!server) {
                    res.status(HTTP_STATUS.NOT_FOUND).json({
                        error: 'Server not found'
                    });
                    return;
                }

                res.json(server);
            } catch (error) {
                this.handleError(res, error);
            }
        });

        // Specific server /meta — Resource meta sub-entity per core spec
        this.app.get('/mcpproviders/:providerId/servers/:serverId/meta', async (req, res) => {
            try {
                const { providerId, serverId } = req.params;
                const server = await this.getServerWithVersions(req, providerId, serverId, false);
                if (!server?.meta) {
                    res.status(HTTP_STATUS.NOT_FOUND).json({ error: 'Server not found' });
                    return;
                }

                res.json(server.meta);
            } catch (error) {
                this.handleError(res, error);
            }
        });
        // Specific server version
        this.app.get('/mcpproviders/:providerId/servers/:serverId/versions/:versionId', async (req, res) => {
            try {
                const { providerId, serverId, versionId } = req.params;
                const server = await this.getServerVersion(req, providerId, serverId, versionId);

                if (!server) {
                    res.status(HTTP_STATUS.NOT_FOUND).json({
                        error: 'Server version not found'
                    });
                    return;
                }

                res.json(server);
            } catch (error) {
                this.handleError(res, error);
            }
        });

        // Server versions collection
        this.app.get('/mcpproviders/:providerId/servers/:serverId/versions', async (req, res) => {
            try {
                const { providerId, serverId } = req.params;
                const inline = req.query.inline as string;
                const versions = await this.getServerVersionsList(req, providerId, serverId, inline);

                if (!versions) {
                    res.status(HTTP_STATUS.NOT_FOUND).json({
                        error: 'Server not found'
                    });
                    return;
                }

                res.json(versions);
            } catch (error) {
                this.handleError(res, error);
            }
        });
    }

    /**
     * Get cached grouped servers with TTL and stale-while-revalidate.
     *
     * - Fresh hit: return the cache immediately.
     * - Stale hit: return the stale cache immediately and kick off a
     *   background refresh.
     * - Cold miss: wait for the first fetch (no choice; clients need
     *   data).
     *
     * Concurrent callers share the same in-flight refresh promise so we
     * never duplicate work against the upstream registry.
     */
    private async getCachedGroupedServers(): Promise<Map<string, MCPServerResponse[]>> {
        const now = Date.now();
        const ttl = this.options.cacheTtl;
        const haveCache = this.cachedGroupedServers !== null;
        const isStale = haveCache && now - this.cacheTimestamp >= ttl;

        if (haveCache && !isStale) {
            return this.cachedGroupedServers!;
        }

        if (haveCache && isStale) {
            // Serve stale, refresh in background.
            this.refreshGroupedServersInBackground();
            return this.cachedGroupedServers!;
        }

        // Cold miss: must wait. De-duplicate concurrent waiters.
        return this.refreshGroupedServersInBackground();
    }

    /**
     * Run (or reuse) a background refresh of the grouped-servers cache.
     * Returns the promise so callers can await it on a cold miss.
     */
    private refreshGroupedServersInBackground(): Promise<Map<string, MCPServerResponse[]>> {
        if (this.inflightRefresh) {
            return this.inflightRefresh;
        }

        this.logger.info('Refreshing grouped servers cache');
        const startedAt = Date.now();
        this.inflightRefresh = (async () => {
            try {
                const serverList = await this.mcpService.getAllServers();
                const grouped = this.mcpService.groupServersByProvider(serverList.servers);
                this.cachedGroupedServers = grouped;
                this.cacheTimestamp = Date.now();
                this.logger.info('Grouped servers cache refreshed', {
                    providers: grouped.size,
                    durationMs: Date.now() - startedAt
                });
                return grouped;
            } catch (error) {
                this.logger.error('Failed to refresh grouped servers cache', {
                    error: error instanceof Error ? error.message : String(error)
                });
                throw error;
            } finally {
                this.inflightRefresh = null;
            }
        })();

        // Swallow rejection on the background path so unhandled-rejection
        // logging doesn't fire when no caller is awaiting.
        this.inflightRefresh.catch(() => undefined);
        return this.inflightRefresh;
    }

    /**
     * Get registry root entity
     */
    private async getRegistryEntity(req: express.Request, inline?: string): Promise<RegistryMetadata> {
        const now = new Date().toISOString();
        const shouldInline = inline && (inline === '*' || inline.includes('mcpproviders'));
        const baseUrl = getBaseUrl(req);

        const registry: RegistryMetadata = {
            specversion: REGISTRY_CONFIG.SPEC_VERSION,
            registryid: REGISTRY_CONFIG.ID,
            self: baseUrl,
            xid: '/',
            epoch: 1,
            name: 'MCP Server Registry',
            description: 'Registry of Model Context Protocol (MCP) servers',
            documentation: 'https://modelcontextprotocol.io',
            createdat: now,
            modifiedat: now,
            mcpprovidersurl: `${baseUrl}/mcpproviders`,
            mcpproviderscount: 0
        };

        if (shouldInline) {
            const providers = await this.getMCPProviders(req, inline);
            registry.mcpproviders = providers as any;
            registry.mcpproviderscount = Object.keys(providers).length;
        } else {
            // Keep registry metadata available while the catalog warms in the
            // background. A count of zero is transient until the first
            // successful refresh completes.
            registry.mcpproviderscount = this.cachedGroupedServers?.size ?? 0;
        }

        return registry;
    }

    /**
     * Get all MCP providers with pagination support
     */
    private buildServerVersionRepresentation(baseUrl: string, providerId: string, serverId: string, mcpServer: MCPServerResponse): ServerVersionMetadata {
        const versionMeta = this.mcpService.convertToXRegistryServer(mcpServer, providerId, baseUrl);
        const resourcePath = `/mcpproviders/${providerId}/servers/${serverId}`;

        return {
            ...versionMeta,
            self: `${baseUrl}${resourcePath}/versions/${versionMeta.versionid}`,
            xid: `${resourcePath}/versions/${versionMeta.versionid}`,
            ancestor: resourcePath,
        };
    }

    private buildServerMeta(baseUrl: string, providerId: string, serverMetadata: ServerMetadata, mcpServer: MCPServerResponse): ServerResourceMeta {
        const resourcePath = `/mcpproviders/${providerId}/servers/${serverMetadata.serverid}`;
        const metaPath = `${resourcePath}/meta`;

        return {
            self: `${baseUrl}${metaPath}`,
            xid: metaPath,
            epoch: 1,
            createdat: serverMetadata.createdat,
            modifiedat: serverMetadata.modifiedat,
            readonly: true,
            defaultversionid: serverMetadata.versionid,
            defaultversionurl: `${baseUrl}${resourcePath}/versions/${serverMetadata.versionid}`,
            defaultversionsticky: true,
            ...this.mcpService.getServerResourceMetaAttributes(mcpServer),
        };
    }

    private buildServerResource(
        baseUrl: string,
        providerId: string,
        defaultServer: MCPServerResponse,
        versions?: MCPServerResponse[],
        inlineVersions: boolean = false,
    ): ServerMetadata {
        const serverMetadata = this.mcpService.convertToXRegistryServer(defaultServer, providerId, baseUrl);
        const resourcePath = `/mcpproviders/${providerId}/servers/${serverMetadata.serverid}`;

        const result: ServerMetadata = {
            ...serverMetadata,
            self: `${baseUrl}${resourcePath}`,
            xid: resourcePath,
            metaurl: `${baseUrl}${resourcePath}/meta`,
            meta: this.buildServerMeta(baseUrl, providerId, serverMetadata, defaultServer),
            versionsurl: `${baseUrl}${resourcePath}/versions`,
        };

        if (versions) {
            result.versionscount = versions.length;
            if (inlineVersions) {
                result.versions = versions.reduce<Record<string, ServerVersionMetadata>>((accumulator, mcpServer) => {
                    const version = this.buildServerVersionRepresentation(baseUrl, providerId, serverMetadata.serverid, mcpServer);
                    accumulator[version.versionid] = version;
                    return accumulator;
                }, {});
            }
        }

        return result;
    }

    private selectDefaultServerVersion(versions: MCPServerResponse[]): MCPServerResponse {
        return versions.find((candidate) => candidate._meta?.['io.modelcontextprotocol.registry/official']?.isLatest) || versions[0]!;
    }

    /**
     * Get all MCP providers with pagination support
     */
    private async getMCPProviders(req: express.Request, inline?: string, limit?: number, offset: number = 0): Promise<PaginatedResponse<Record<string, ProviderMetadata>>> {
        const grouped = await this.getCachedGroupedServers();
        const shouldInlineServers = inline ? (inline === '*' || inline.includes('servers')) : false;
        const baseUrl = getBaseUrl(req);

        const allProviderIds = Array.from(grouped.keys()).sort();
        const totalCount = allProviderIds.length;
        const effectiveLimit = limit && limit > 0 && limit <= PAGINATION.MAX_PAGE_LIMIT ? limit : totalCount;
        const startIndex = Math.min(offset, totalCount);
        const endIndex = Math.min(startIndex + effectiveLimit, totalCount);
        const providerIds = allProviderIds.slice(startIndex, endIndex);

        const providers: Record<string, ProviderMetadata> = {};
        const now = new Date().toISOString();

        for (const providerId of providerIds) {
            const servers = grouped.get(providerId)!;
            const provider: ProviderMetadata = {
                mcpproviderid: providerId,
                self: `${baseUrl}/mcpproviders/${providerId}`,
                xid: `/mcpproviders/${providerId}`,
                epoch: 1,
                name: providerId,
                description: `MCP servers from ${providerId}`,
                createdat: now,
                modifiedat: now,
                serversurl: `${baseUrl}/mcpproviders/${providerId}/servers`,
                serverscount: servers.length,
            };

            if (shouldInlineServers) {
                provider.servers = {};
                for (const mcpServer of servers) {
                    const serverResource = this.buildServerResource(baseUrl, providerId, mcpServer);
                    provider.servers[serverResource.serverid] = serverResource;
                }
            }

            providers[providerId] = provider;
        }

        const links: string[] = [];
        const hasLimit = limit !== undefined && limit > 0;

        if (hasLimit) {
            if (startIndex > 0) {
                const prevOffset = Math.max(0, startIndex - effectiveLimit);
                links.push(`<${baseUrl}/mcpproviders?limit=${effectiveLimit}&offset=${prevOffset}>; rel="prev"; count=${totalCount}`);
            }
            if (endIndex < totalCount) {
                links.push(`<${baseUrl}/mcpproviders?limit=${effectiveLimit}&offset=${endIndex}>; rel="next"; count=${totalCount}`);
            }
            links.push(`<${baseUrl}/mcpproviders?limit=${effectiveLimit}>; rel="first"; count=${totalCount}`);
            links.push(`<${baseUrl}/mcpproviders?limit=${effectiveLimit}&offset=${Math.max(0, totalCount - effectiveLimit)}>; rel="last"; count=${totalCount}`);
        }

        return {
            data: providers,
            links: links.length > 0 ? links : undefined,
            count: totalCount,
        };
    }

    /**
     * Get a specific MCP provider
     */
    private async getMCPProvider(req: express.Request, providerId: string, inline?: string): Promise<ProviderMetadata | null> {
        const grouped = await this.getCachedGroupedServers();
        const baseUrl = getBaseUrl(req);

        if (!grouped.has(providerId)) {
            return null;
        }

        const servers = grouped.get(providerId)!;
        const now = new Date().toISOString();
        const shouldInlineServers = inline ? (inline === '*' || inline.includes('servers')) : false;

        const provider: ProviderMetadata = {
            mcpproviderid: providerId,
            self: `${baseUrl}/mcpproviders/${providerId}`,
            xid: `/mcpproviders/${providerId}`,
            epoch: 1,
            name: providerId,
            description: `MCP servers from ${providerId}`,
            createdat: now,
            modifiedat: now,
            serversurl: `${baseUrl}/mcpproviders/${providerId}/servers`,
            serverscount: servers.length,
        };

        if (shouldInlineServers) {
            provider.servers = {};
            for (const mcpServer of servers) {
                const serverResource = this.buildServerResource(baseUrl, providerId, mcpServer);
                provider.servers[serverResource.serverid] = serverResource;
            }
        }

        return provider;
    }

    /**
     * Get servers for a specific provider with pagination support
     */
    private async getServersForProvider(req: express.Request, providerId: string, limit?: number, offset: number = 0): Promise<PaginatedResponse<Record<string, ServerMetadata>>> {
        const grouped = await this.getCachedGroupedServers();
        const baseUrl = getBaseUrl(req);

        if (!grouped.has(providerId)) {
            return { data: {}, count: 0 };
        }

        const allServers = grouped.get(providerId)!;
        const totalCount = allServers.length;
        const effectiveLimit = limit && limit > 0 && limit <= PAGINATION.MAX_PAGE_LIMIT ? limit : totalCount;
        const startIndex = Math.min(offset, totalCount);
        const endIndex = Math.min(startIndex + effectiveLimit, totalCount);
        const serversPage = allServers.slice(startIndex, endIndex);

        const result: Record<string, ServerMetadata> = {};
        for (const mcpServer of serversPage) {
            const serverResource = this.buildServerResource(baseUrl, providerId, mcpServer);
            result[serverResource.serverid] = serverResource;
        }

        const links: string[] = [];
        const hasLimit = limit !== undefined && limit > 0;
        const serversBaseUrl = `${baseUrl}/mcpproviders/${providerId}/servers`;

        if (hasLimit) {
            if (startIndex > 0) {
                const prevOffset = Math.max(0, startIndex - effectiveLimit);
                links.push(`<${serversBaseUrl}?limit=${effectiveLimit}&offset=${prevOffset}>; rel="prev"; count=${totalCount}`);
            }
            if (endIndex < totalCount) {
                links.push(`<${serversBaseUrl}?limit=${effectiveLimit}&offset=${endIndex}>; rel="next"; count=${totalCount}`);
            }
            links.push(`<${serversBaseUrl}?limit=${effectiveLimit}>; rel="first"; count=${totalCount}`);
            links.push(`<${serversBaseUrl}?limit=${effectiveLimit}&offset=${Math.max(0, totalCount - effectiveLimit)}>; rel="last"; count=${totalCount}`);
        }

        return {
            data: result,
            links: links.length > 0 ? links : undefined,
            count: totalCount,
        };
    }

    /**
     * Get a specific server
     */
    private async getServer(req: express.Request, providerId: string, serverId: string): Promise<ServerMetadata | null> {
        const baseUrl = getBaseUrl(req);
        const versionsResponse = await this.mcpService.resolveServerVersions(providerId, serverId);
        if (!versionsResponse?.servers?.length) {
            return null;
        }

        const defaultServer = this.selectDefaultServerVersion(versionsResponse.servers);
        return this.buildServerResource(baseUrl, providerId, defaultServer, versionsResponse.servers, false);
    }

    /**
     * Get server with versions support
     */
    private async getServerWithVersions(req: express.Request, providerId: string, serverId: string, inlineVersions: boolean): Promise<ServerMetadata | null> {
        const baseUrl = getBaseUrl(req);
        const versionsResponse = await this.mcpService.resolveServerVersions(providerId, serverId);
        if (!versionsResponse?.servers?.length) {
            return null;
        }

        const defaultServer = this.selectDefaultServerVersion(versionsResponse.servers);
        return this.buildServerResource(baseUrl, providerId, defaultServer, versionsResponse.servers, inlineVersions);
    }

    /**
     * Get specific server version
     */
    private async getServerVersion(req: express.Request, providerId: string, serverId: string, versionId: string): Promise<ServerVersionMetadata | null> {
        const baseUrl = getBaseUrl(req);
        const versionsResponse = await this.mcpService.resolveServerVersions(providerId, serverId);
        if (!versionsResponse?.servers) {
            return null;
        }

        for (const mcpServer of versionsResponse.servers) {
            const version = this.buildServerVersionRepresentation(baseUrl, providerId, serverId, mcpServer);
            if (version.versionid === versionId) {
                return version;
            }
        }

        return null;
    }

    /**
     * Get server versions list - returns enumerated versions
     */
    private async getServerVersionsList(req: express.Request, providerId: string, serverId: string, inline?: string): Promise<Record<string, ServerVersionMetadata> | null> {
        const baseUrl = getBaseUrl(req);
        const versionsResponse = await this.mcpService.resolveServerVersions(providerId, serverId);
        if (!versionsResponse?.servers?.length) {
            return null;
        }

        const versions: Record<string, ServerVersionMetadata> = {};
        for (const mcpServer of versionsResponse.servers) {
            const version = this.buildServerVersionRepresentation(baseUrl, providerId, serverId, mcpServer);
            versions[version.versionid] = version;
        }

        return versions;
    }
    /**
     * Setup error handling
     */
    private setupErrorHandling(): void {
        this.app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
            this.logger.error('Unhandled error', err);
            res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
                error: 'Internal server error',
                message: err.message
            });
        });
    }

    /**
     * Handle error response
     */
    private handleError(res: express.Response, error: any): void {
        this.logger.error('Request error', error);
        if (axios.isAxiosError(error) && error.code === 'ECONNABORTED') {
            res.status(HTTP_STATUS.GATEWAY_TIMEOUT).json({
                error: 'Gateway timeout',
                message: 'MCP Registry request timed out'
            });
            return;
        }

        res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
            error: 'Internal server error',
            message: error.message || 'Unknown error'
        });
    }

    /**
     * Start the server
     */
    async start(): Promise<void> {
        return new Promise((resolve) => {
            this.server = this.app.listen(this.options.port, this.options.host, () => {
                this.logger.info(`MCP xRegistry server listening on ${this.options.host}:${this.options.port}`);
                // Begin warming the catalog cache as soon as the listener
                // is up. We don't await it: the HTTP server is already
                // ready to accept /health and other no-catalog routes.
                // The first /mcpproviders... request that arrives before
                // the warmup completes will still get a real (blocking)
                // wait via the shared inflightRefresh promise; after the
                // warmup completes everything is hot.
                this.refreshGroupedServersInBackground();
                resolve();
            });
        });
    }

    /**
     * Stop the server
     */
    async stop(): Promise<void> {
        return new Promise((resolve, reject) => {
            if (this.server) {
                this.server.close((err: any) => {
                    if (err) {
                        reject(err);
                    } else {
                        this.logger.info('Server stopped');
                        resolve();
                    }
                });
            } else {
                resolve();
            }
        });
    }
}

// Start server if run directly
if (require.main === module) {
    const server = new XRegistryServer({
        port: parseInt(process.env.XREGISTRY_MCP_PORT || '3600'),
        host: process.env.XREGISTRY_MCP_HOST || '0.0.0.0',
        mcpRegistryUrl: process.env.XREGISTRY_MCP_REGISTRY_URL,
        upstreamTimeout: process.env.XREGISTRY_MCP_UPSTREAM_TIMEOUT_MS
            ? parseInt(process.env.XREGISTRY_MCP_UPSTREAM_TIMEOUT_MS, 10)
            : undefined,
        baseUrl: process.env.XREGISTRY_MCP_BASEURL,
        logLevel: process.env.LOG_LEVEL
    });

    server.start().catch((error) => {
        console.error('Failed to start server:', error);
        process.exit(1);
    });

    // Graceful shutdown
    process.on('SIGTERM', async () => {
        console.log('SIGTERM received, shutting down gracefully...');
        await server.stop();
        process.exit(0);
    });

    process.on('SIGINT', async () => {
        console.log('SIGINT received, shutting down gracefully...');
        await server.stop();
        process.exit(0);
    });
}
