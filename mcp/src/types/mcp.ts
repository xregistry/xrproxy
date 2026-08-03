/**
 * MCP Registry API type definitions.
 */

export type JSONPrimitive = string | number | boolean | null;
export type JSONValue = JSONPrimitive | JSONObject | JSONArray;
export interface JSONObject {
    [key: string]: JSONValue;
}
export type JSONArray = JSONValue[];

export interface MCPRepository {
    url: string;
    source: string;
    id?: string;
    subfolder?: string;
}

export interface MCPIcon {
    src: string;
    mimeType?: 'image/png' | 'image/jpeg' | 'image/jpg' | 'image/svg+xml' | 'image/webp';
    sizes?: string[];
    theme?: 'light' | 'dark';
}

export type MCPTransportType = 'stdio' | 'streamable-http' | 'sse';
export type MCPRemoteTransportType = Exclude<MCPTransportType, 'stdio'>;
export type MCPInputFormat = 'string' | 'number' | 'boolean' | 'filepath';
export type MCPArgumentType = 'positional' | 'named';
export type MCPRegistryType = 'npm' | 'pypi' | 'oci' | 'nuget' | 'mcpb';
export type MCPRuntimeHint = 'npx' | 'uvx' | 'docker' | 'dnx';

export interface MCPVariableInput {
    description?: string;
    isRequired?: boolean;
    isSecret?: boolean;
    default?: string;
    format?: MCPInputFormat;
    value?: string;
    choices?: string[];
}

export interface MCPInput extends MCPVariableInput {
    placeholder?: string;
    variables?: Record<string, MCPVariableInput>;
}

export interface MCPNamedInput extends MCPInput {
    name: string;
}

export interface MCPArgument extends MCPInput {
    type: MCPArgumentType;
    name?: string;
    valueHint?: string;
    isRepeated?: boolean;
}

export interface MCPTransport {
    type: MCPTransportType;
    url?: string;
    headers?: MCPNamedInput[];
}

export interface MCPRemote {
    type: MCPRemoteTransportType;
    url: string;
    headers?: MCPNamedInput[];
    variables?: Record<string, MCPVariableInput>;
}

export interface MCPPackage {
    registryType: MCPRegistryType;
    packagexid?: string;
    registryBaseUrl?: string;
    identifier: string;
    version?: string;
    fileSha256?: string;
    runtimeHint?: MCPRuntimeHint;
    transport: MCPTransport;
    runtimeArguments?: MCPArgument[];
    packageArguments?: MCPArgument[];
    environmentVariables?: MCPNamedInput[];
}

export interface MCPServerDetail {
    $schema?: string;
    name: string;
    description: string;
    title?: string;
    repository?: MCPRepository;
    version: string;
    websiteUrl?: string;
    icons?: MCPIcon[];
    packages?: MCPPackage[];
    remotes?: MCPRemote[];
    prompts?: unknown[];
    tools?: unknown[];
    resources?: unknown[];
    _meta?: {
        'io.modelcontextprotocol.registry/publisher-provided'?: JSONObject;
        [key: string]: unknown;
    };
}

export interface MCPServerOfficialMeta {
    status?: 'active' | 'deprecated' | 'deleted';
    statusMessage?: string;
    statusChangedAt?: string;
    publishedAt?: string;
    updatedAt?: string;
    isLatest?: boolean;
}

export interface MCPServerResponse {
    server: MCPServerDetail;
    _meta?: {
        'io.modelcontextprotocol.registry/official'?: MCPServerOfficialMeta;
        [key: string]: unknown;
    };
}

export interface MCPServerListResponse {
    servers: MCPServerResponse[];
    metadata?: {
        nextCursor?: string;
        count?: number;
    };
}

export interface CacheMetadata {
    lastUpdated: number;
    serverCount: number;
    etag?: string;
}

export interface CachedResponse<T> {
    data: T;
    etag: string | null;
    timestamp: number;
}
