/**
 * MCP Registry Service.
 */

import axios, { AxiosInstance, AxiosResponse } from 'axios';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { CACHE_CONFIG, MCP_REGISTRY } from '../config/constants';
import {
    CachedResponse,
    CacheMetadata,
    MCPIcon,
    MCPInput,
    MCPNamedInput,
    MCPPackage,
    MCPRemote,
    MCPRepository,
    MCPServerListResponse,
    MCPServerResponse,
    MCPTransport,
    MCPVariableInput,
} from '../types/mcp';
import {
    ServerMetaAttributes,
    ServerMetadata,
    XRegistryIcon,
    XRegistryInputDescriptor,
    XRegistryNamedInputDescriptor,
    XRegistryPackage,
    XRegistryRemote,
    XRegistryRepository,
    XRegistryTransport,
    XRegistryVariableDescriptor,
} from '../types/xregistry';

const ENTITY_ID_PATTERN = /^[A-Za-z0-9._~:@-]+$/;
const PYPI_NORMALIZATION_PATTERN = /[-_.]+/g;

export interface MCPServiceConfig {
    baseUrl?: string;
    timeout?: number;
    userAgent?: string;
    cacheDir?: string;
    cacheTtl?: number;
}

interface ParsedServerName {
    providerId: string;
    serverName: string;
}

export class MCPService {
    private httpClient: AxiosInstance;
    private cacheDir: string;
    private cacheTtl: number;
    private baseUrl: string;
    private lastFetchTime = 0;

    constructor(config: MCPServiceConfig = {}) {
        this.baseUrl = config.baseUrl || MCP_REGISTRY.BASE_URL;
        this.cacheDir = config.cacheDir || CACHE_CONFIG.CACHE_DIR;
        this.cacheTtl = config.cacheTtl ?? CACHE_CONFIG.CACHE_TTL_MS;

        this.httpClient = axios.create({
            timeout: config.timeout ?? MCP_REGISTRY.TIMEOUT_MS,
            headers: {
                'User-Agent': config.userAgent || MCP_REGISTRY.USER_AGENT,
                Accept: 'application/json',
            },
            validateStatus: (status) => status >= 200 && status < 500,
        });

        if (!fs.existsSync(this.cacheDir)) {
            fs.mkdirSync(this.cacheDir, { recursive: true });
        }

        this.loadCacheMetadata();
    }

    private loadCacheMetadata(): void {
        const metadataFile = path.join(this.cacheDir, 'cache-metadata.json');
        if (!fs.existsSync(metadataFile)) {
            return;
        }

        try {
            const metadata: CacheMetadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
            this.lastFetchTime = metadata.lastUpdated;
        } catch (error) {
            console.warn('Failed to load cache metadata:', error);
        }
    }

    private saveCacheMetadata(serverCount: number, etag?: string): void {
        const metadataFile = path.join(this.cacheDir, 'cache-metadata.json');
        const metadata: CacheMetadata = {
            lastUpdated: Date.now(),
            serverCount,
            etag,
        };

        fs.writeFileSync(metadataFile, JSON.stringify(metadata, null, 2));
        this.lastFetchTime = metadata.lastUpdated;
    }

    private async cachedGet<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
        const cacheFile = path.join(this.cacheDir, Buffer.from(url).toString('base64url'));
        let etag: string | null = null;
        let cachedData: T | null = null;

        if (fs.existsSync(cacheFile)) {
            try {
                const cached: CachedResponse<T> = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
                etag = cached.etag;
                cachedData = cached.data;

                if (Date.now() - cached.timestamp < this.cacheTtl) {
                    return cached.data;
                }
            } catch {
                // Ignore malformed cache entries.
            }
        }

        const requestHeaders = { ...headers };
        if (etag) {
            requestHeaders['If-None-Match'] = etag;
        }

        try {
            const response: AxiosResponse<T> = await this.httpClient.get(url, {
                headers: requestHeaders,
                validateStatus: (status) => status < 500,
            });

            if (response.status === 200) {
                const newEtag = response.headers['etag'] || null;
                const cacheData: CachedResponse<T> = {
                    etag: newEtag,
                    data: response.data,
                    timestamp: Date.now(),
                };
                fs.writeFileSync(cacheFile, JSON.stringify(cacheData));
                return response.data;
            }

            if (response.status === 304 && cachedData) {
                fs.writeFileSync(cacheFile, JSON.stringify({
                    etag,
                    data: cachedData,
                    timestamp: Date.now(),
                } satisfies CachedResponse<T>));
                return cachedData;
            }

            if (response.status >= 400) {
                if (cachedData) {
                    return cachedData;
                }
                throw new Error(`HTTP ${response.status}: ${JSON.stringify(response.data)}`);
            }
        } catch (error: unknown) {
            if (axios.isAxiosError(error) && cachedData) {
                if (error.code === 'ECONNABORTED' || error.code === 'ENOTFOUND' || error.code === 'ETIMEDOUT') {
                    return cachedData;
                }
            }

            if (cachedData) {
                return cachedData;
            }
            throw error;
        }

        if (cachedData) {
            return cachedData;
        }

        throw new Error(`Failed to fetch ${url} and no cache available`);
    }

    async getAllServers(options: { limit?: number; search?: string; version?: string; updatedSince?: string } = {}): Promise<MCPServerListResponse> {
        const allServers: MCPServerResponse[] = [];
        let cursor: string | undefined;
        const pageLimit = 100;

        if (options.limit && options.limit <= pageLimit) {
            let url = `${this.baseUrl}${MCP_REGISTRY.SERVERS_ENDPOINT}`;
            const params: string[] = [`limit=${options.limit}`];

            if (options.search) {
                params.push(`search=${encodeURIComponent(options.search)}`);
            }
            if (options.version) {
                params.push(`version=${encodeURIComponent(options.version)}`);
            }
            if (options.updatedSince) {
                params.push(`updated_since=${encodeURIComponent(options.updatedSince)}`);
            }

            url += `?${params.join('&')}`;
            return this.cachedGet<MCPServerListResponse>(url);
        }

        do {
            let url = `${this.baseUrl}${MCP_REGISTRY.SERVERS_ENDPOINT}`;
            const params: string[] = [`limit=${pageLimit}`];

            if (cursor) {
                params.push(`cursor=${encodeURIComponent(cursor)}`);
            }
            if (options.search) {
                params.push(`search=${encodeURIComponent(options.search)}`);
            }
            if (options.version) {
                params.push(`version=${encodeURIComponent(options.version)}`);
            }
            if (options.updatedSince) {
                params.push(`updated_since=${encodeURIComponent(options.updatedSince)}`);
            }

            url += `?${params.join('&')}`;
            const response = await this.cachedGet<MCPServerListResponse>(url);

            if (response.servers.length > 0) {
                allServers.push(...response.servers);
            }

            cursor = response.metadata?.nextCursor;
            if (options.limit && allServers.length >= options.limit) {
                break;
            }
        } while (cursor);

        this.saveCacheMetadata(allServers.length);

        return {
            servers: options.limit ? allServers.slice(0, options.limit) : allServers,
            metadata: {
                count: options.limit ? Math.min(allServers.length, options.limit) : allServers.length,
                nextCursor: undefined,
            },
        };
    }

    async getServer(serverName: string, version = 'latest'): Promise<MCPServerResponse | null> {
        try {
            const encodedName = encodeURIComponent(serverName);
            const encodedVersion = encodeURIComponent(version);
            const url = `${this.baseUrl}${MCP_REGISTRY.SERVERS_ENDPOINT}/${encodedName}/versions/${encodedVersion}`;
            return await this.cachedGet<MCPServerResponse>(url);
        } catch (error) {
            if (this.isNotFoundError(error)) {
                return null;
            }
            throw error;
        }
    }

    async getServerVersions(serverName: string): Promise<MCPServerListResponse | null> {
        try {
            const encodedName = encodeURIComponent(serverName);
            const url = `${this.baseUrl}${MCP_REGISTRY.SERVERS_ENDPOINT}/${encodedName}/versions`;
            return await this.cachedGet<MCPServerListResponse>(url);
        } catch (error) {
            if (this.isNotFoundError(error)) {
                return null;
            }
            throw error;
        }
    }

    async resolveServerVersions(providerId: string, serverId: string): Promise<MCPServerListResponse | null> {
        if (!serverId.startsWith('xh~')) {
            const direct = await this.getServerVersions(`${providerId}/${serverId}`);
            if (this.containsServer(direct, providerId, serverId)) {
                return direct;
            }
        }

        const searched = await this.getAllServers({ limit: 100, search: providerId });
        const searchedMatch = this.findMatchingServerName(searched.servers, providerId, serverId);
        if (searchedMatch) {
            return this.getServerVersions(searchedMatch);
        }

        const allServers = await this.getAllServers();
        const fullMatch = this.findMatchingServerName(allServers.servers, providerId, serverId);
        if (!fullMatch) {
            return null;
        }

        return this.getServerVersions(fullMatch);
    }

    private findMatchingServerName(servers: MCPServerResponse[], providerId: string, serverId: string): string | null {
        const match = servers.find((server) => this.matchesIdentity(server, providerId, serverId));
        return match?.server.name ?? null;
    }

    private containsServer(response: MCPServerListResponse | null, providerId: string, serverId: string): boolean {
        return response?.servers?.some((server) => this.matchesIdentity(server, providerId, serverId)) ?? false;
    }

    private matchesIdentity(server: MCPServerResponse, providerId: string, serverId: string): boolean {
        const parsed = this.parseServerName(server.server.name);
        if (!parsed) {
            return false;
        }

        return parsed.providerId === providerId && this.deriveServerId(parsed.serverName) === serverId;
    }

    private isNotFoundError(error: unknown): boolean {
        return (axios.isAxiosError(error) && error.response?.status === 404) ||
            (error instanceof Error && error.message.startsWith('HTTP 404:'));
    }

    convertToXRegistryServer(mcpResponse: MCPServerResponse, providerId: string, baseUrl: string): ServerMetadata {
        const { server } = mcpResponse;
        const parsed = this.parseServerName(server.name);
        const effectiveProviderId = parsed?.providerId ?? providerId;
        const serverName = parsed?.serverName ?? server.name;
        const serverId = this.deriveServerId(serverName);
        const versionId = this.deriveVersionId(server.version);
        const resourcePath = `/mcpproviders/${effectiveProviderId}/servers/${serverId}`;
        const timestamps = this.getTimestamps(mcpResponse);

        const result: ServerMetadata = {
            serverid: serverId,
            versionid: versionId,
            self: `${baseUrl}${resourcePath}`,
            xid: resourcePath,
            epoch: 1,
            name: server.name,
            description: server.description,
            createdat: timestamps.createdat,
            modifiedat: timestamps.modifiedat,
            ancestor: resourcePath,
            version: server.version,
        };

        if (server.$schema) {
            result.schemaurl = server.$schema;
        }
        if (server.title) {
            result.title = server.title;
        }
        if (server.websiteUrl) {
            result.website_url = server.websiteUrl;
        }

        const icons = this.mapIcons(server.icons);
        if (icons?.length) {
            result.icons = icons;
        }

        const repository = this.mapRepository(server.repository);
        if (repository) {
            result.repository = repository;
        }

        const packages = server.packages?.map((pkg) => this.mapPackage(pkg)).filter((pkg): pkg is XRegistryPackage => pkg !== null);
        if (packages?.length) {
            result.packages = packages;
        }

        const remotes = server.remotes?.map((remote) => this.mapRemote(remote)).filter((remote): remote is XRegistryRemote => remote !== null);
        if (remotes?.length) {
            result.remotes = remotes;
        }

        const publisherMeta = server._meta?.['io.modelcontextprotocol.registry/publisher-provided'];
        if (publisherMeta) {
            result.publisher_meta = publisherMeta;
        }

        return result;
    }

    getServerResourceMetaAttributes(mcpResponse: MCPServerResponse): ServerMetaAttributes {
        const official = mcpResponse._meta?.['io.modelcontextprotocol.registry/official'];
        const result: ServerMetaAttributes = {};

        if (official?.status) {
            result.status = official.status;
        }
        if (official?.statusMessage) {
            result.status_message = official.statusMessage;
        }
        if (official?.statusChangedAt) {
            result.status_changed_at = official.statusChangedAt;
        }
        if (official?.publishedAt) {
            result.published_at = official.publishedAt;
        }
        if (official?.updatedAt) {
            result.updated_at = official.updatedAt;
        }
        if (official?.isLatest !== undefined) {
            result.is_latest = official.isLatest;
        }

        return result;
    }

    deriveVersionId(version: string): string {
        return version.replace(/\+/g, '~');
    }

    deriveServerId(name: string): string {
        return this.deriveEntityId(name);
    }

    extractProviderId(serverName: string): string | null {
        return this.parseServerName(serverName)?.providerId ?? null;
    }

    groupServersByProvider(servers: MCPServerResponse[]): Map<string, MCPServerResponse[]> {
        const grouped = new Map<string, MCPServerResponse[]>();

        for (const serverResponse of servers) {
            const parsed = this.parseServerName(serverResponse.server.name);
            if (!parsed) {
                continue;
            }

            if (!grouped.has(parsed.providerId)) {
                grouped.set(parsed.providerId, []);
            }
            grouped.get(parsed.providerId)!.push(serverResponse);
        }

        return grouped;
    }

    getCacheStats(): { lastUpdated: number; cacheDir: string } {
        return {
            lastUpdated: this.lastFetchTime,
            cacheDir: this.cacheDir,
        };
    }

    private getTimestamps(mcpResponse: MCPServerResponse): { createdat: string; modifiedat: string } {
        const now = new Date().toISOString();
        const official = mcpResponse._meta?.['io.modelcontextprotocol.registry/official'];

        return {
            createdat: official?.publishedAt || now,
            modifiedat: official?.updatedAt || official?.publishedAt || now,
        };
    }

    private parseServerName(serverName: string): ParsedServerName | null {
        const separator = serverName.indexOf('/');
        if (separator <= 0 || separator !== serverName.lastIndexOf('/')) {
            return null;
        }

        return {
            providerId: serverName.slice(0, separator),
            serverName: serverName.slice(separator + 1),
        };
    }

    private deriveEntityId(value: string): string {
        if (value.length <= 128 && ENTITY_ID_PATTERN.test(value) && !value.startsWith('xh~')) {
            return value;
        }

        return `xh~${createHash('sha256').update(value, 'utf8').digest('hex')}`;
    }

    private normalizePythonPackageId(identifier: string): string {
        return identifier.toLowerCase().replace(PYPI_NORMALIZATION_PATTERN, '-');
    }

    private normalizeOciRegistryId(url?: string): string {
        if (!url) {
            return 'docker.io';
        }

        try {
            const hostname = new URL(url).hostname.toLowerCase();
            if (hostname === 'registry-1.docker.io' || hostname === 'index.docker.io') {
                return 'docker.io';
            }
            return hostname;
        } catch {
            return 'docker.io';
        }
    }

    private generatePackageXid(pkg: MCPPackage): string | undefined {
        if (!pkg.identifier) {
            return undefined;
        }

        switch (pkg.registryType) {
            case 'npm': {
                const match = pkg.identifier.match(/^@([^/]+)\/(.+)$/);
                const scope = match ? match[1] : '_';
                const packageName = match ? match[2] : pkg.identifier;
                return `/nodescopes/${scope}/packages/${this.deriveEntityId(packageName)}`;
            }
            case 'pypi':
                return `/pythonregistries/pypi/packages/${this.normalizePythonPackageId(pkg.identifier)}`;
            case 'oci':
                return `/containerregistries/${this.normalizeOciRegistryId(pkg.registryBaseUrl)}/images/${this.deriveEntityId(pkg.identifier.replace(/\//g, '~'))}`;
            case 'nuget':
                return `/dotnetregistries/nuget/packages/${pkg.identifier.toLowerCase()}`;
            case 'mcpb': {
                try {
                    new URL(pkg.identifier);
                    return pkg.identifier;
                } catch {
                    return undefined;
                }
            }
            default:
                return undefined;
        }
    }

    private mapIcons(icons?: MCPIcon[]): XRegistryIcon[] | undefined {
        return icons?.map((icon) => {
            const result: XRegistryIcon = { src: icon.src };
            if (icon.mimeType) {
                result.mime_type = icon.mimeType;
            }
            if (icon.sizes?.length) {
                result.sizes = [...icon.sizes];
            }
            if (icon.theme) {
                result.theme = icon.theme;
            }
            return result;
        });
    }

    private mapRepository(repository?: MCPRepository): XRegistryRepository | undefined {
        if (!repository) {
            return undefined;
        }

        const result: XRegistryRepository = {
            url: repository.url,
            source: repository.source,
        };
        if (repository.id) {
            result.id = repository.id;
        }
        if (repository.subfolder) {
            result.subfolder = repository.subfolder;
        }
        return result;
    }

    private mapVariableDescriptor(input?: MCPVariableInput): XRegistryVariableDescriptor | undefined {
        if (!input) {
            return undefined;
        }

        const result: XRegistryVariableDescriptor = {};
        if (input.description) {
            result.description = input.description;
        }
        if (input.isRequired !== undefined) {
            result.is_required = input.isRequired;
        }
        if (input.isSecret !== undefined) {
            result.is_secret = input.isSecret;
        }
        if (input.default !== undefined) {
            result.default = input.default;
        }
        if (input.format) {
            result.format = input.format;
        }
        if (input.value !== undefined) {
            result.value = input.value;
        }
        if (input.choices?.length) {
            result.choices = [...input.choices];
        }

        return Object.keys(result).length > 0 ? result : undefined;
    }

    private mapVariables(variables?: Record<string, MCPVariableInput>): Record<string, XRegistryVariableDescriptor> | undefined {
        if (!variables) {
            return undefined;
        }

        const mapped = Object.entries(variables).reduce<Record<string, XRegistryVariableDescriptor>>((accumulator, [name, descriptor]) => {
            const converted = this.mapVariableDescriptor(descriptor);
            if (converted) {
                accumulator[name] = converted;
            }
            return accumulator;
        }, {});

        return Object.keys(mapped).length > 0 ? mapped : undefined;
    }

    private mapInputDescriptor(input: MCPInput): XRegistryInputDescriptor {
        const result: XRegistryInputDescriptor = {};
        if (input.description) {
            result.description = input.description;
        }
        if (input.isRequired !== undefined) {
            result.is_required = input.isRequired;
        }
        if (input.isSecret !== undefined) {
            result.is_secret = input.isSecret;
        }
        if (input.default !== undefined) {
            result.default = input.default;
        }
        if (input.format) {
            result.format = input.format;
        }
        if (input.value !== undefined) {
            result.value = input.value;
        }
        if (input.placeholder !== undefined) {
            result.placeholder = input.placeholder;
        }
        if (input.choices?.length) {
            result.choices = [...input.choices];
        }
        const variables = this.mapVariables(input.variables);
        if (variables) {
            result.variables = variables;
        }
        return result;
    }

    private mapNamedInputDescriptor(input: MCPNamedInput): XRegistryNamedInputDescriptor {
        return {
            name: input.name,
            ...this.mapInputDescriptor(input),
        };
    }

    private mapArgumentDescriptor(input: MCPInput & { type: 'positional' | 'named'; name?: string; valueHint?: string; isRepeated?: boolean }): XRegistryInputDescriptor {
        const result: XRegistryInputDescriptor = {
            ...this.mapInputDescriptor(input),
            type: input.type,
        };

        if (input.name) {
            result.name = input.name;
        }
        if (input.valueHint) {
            result.value_hint = input.valueHint;
        }
        if (input.isRepeated !== undefined) {
            result.is_repeated = input.isRepeated;
        }
        return result;
    }

    private mapTransport(transport: MCPTransport): XRegistryTransport {
        const result: XRegistryTransport = { type: transport.type };

        if (transport.type !== 'stdio') {
            if (transport.url) {
                result.url = transport.url;
            }
            if (transport.headers?.length) {
                result.headers = transport.headers.map((header) => this.mapNamedInputDescriptor(header));
            }
        }

        return result;
    }

    private mapRemote(remote: MCPRemote): XRegistryRemote | null {
        const result: XRegistryRemote = {
            type: remote.type,
            url: remote.url,
        };

        if (remote.headers?.length) {
            result.headers = remote.headers.map((header) => this.mapNamedInputDescriptor(header));
        }

        const variables = this.mapVariables(remote.variables);
        if (variables) {
            result.variables = variables;
        }

        return result;
    }

    private mapPackage(pkg: MCPPackage): XRegistryPackage | null {
        if (!pkg.transport) {
            return null;
        }

        const result: XRegistryPackage = {
            registry_type: pkg.registryType,
            identifier: pkg.identifier,
            transport: this.mapTransport(pkg.transport),
        };

        if (pkg.registryBaseUrl) {
            result.registry_base_url = pkg.registryBaseUrl;
        }
        if (pkg.version) {
            result.version = pkg.version;
        }
        if (pkg.fileSha256) {
            result.file_sha256 = pkg.fileSha256;
        }
        if (pkg.runtimeHint) {
            result.runtime_hint = pkg.runtimeHint;
        }

        const packageXid = pkg.packagexid || this.generatePackageXid(pkg);
        if (packageXid) {
            result.packagexid = packageXid;
        }
        if (pkg.runtimeArguments?.length) {
            result.runtime_arguments = pkg.runtimeArguments.map((argument) => this.mapArgumentDescriptor(argument));
        }
        if (pkg.packageArguments?.length) {
            result.package_arguments = pkg.packageArguments.map((argument) => this.mapArgumentDescriptor(argument));
        }
        if (pkg.environmentVariables?.length) {
            result.environment_variables = pkg.environmentVariables.map((environmentVariable) => this.mapNamedInputDescriptor(environmentVariable));
        }

        return result;
    }
}
