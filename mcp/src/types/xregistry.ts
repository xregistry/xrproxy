/**
 * xRegistry entity type definitions for the MCP projection.
 */

import { JSONValue } from './mcp';

export interface PaginatedResponse<T> {
    data: T;
    links?: string[];
    count?: number;
}

export type XRegistryInputFormat = 'string' | 'number' | 'boolean' | 'filepath';
export type XRegistryArgumentType = 'positional' | 'named';
export type XRegistryTransportType = 'stdio' | 'streamable-http' | 'sse';
export type XRegistryRemoteTransportType = Exclude<XRegistryTransportType, 'stdio'>;
export type XRegistryRegistryType = 'npm' | 'pypi' | 'oci' | 'nuget' | 'mcpb';
export type XRegistryRuntimeHint = 'npx' | 'uvx' | 'docker' | 'dnx';

export interface XRegistryVariableDescriptor {
    description?: string;
    is_required?: boolean;
    is_secret?: boolean;
    default?: string;
    format?: XRegistryInputFormat;
    value?: string;
    choices?: string[];
}

export interface XRegistryInputDescriptor extends XRegistryVariableDescriptor {
    name?: string;
    type?: XRegistryArgumentType;
    value_hint?: string;
    is_repeated?: boolean;
    placeholder?: string;
    variables?: Record<string, XRegistryVariableDescriptor>;
}

export interface XRegistryNamedInputDescriptor extends XRegistryInputDescriptor {
    name: string;
}

export interface XRegistryTransport {
    type: XRegistryTransportType;
    url?: string;
    headers?: XRegistryNamedInputDescriptor[];
}

export interface XRegistryRemote {
    type: XRegistryRemoteTransportType;
    url: string;
    headers?: XRegistryNamedInputDescriptor[];
    variables?: Record<string, XRegistryVariableDescriptor>;
}

export interface XRegistryPackage {
    registry_type: XRegistryRegistryType;
    registry_base_url?: string;
    identifier: string;
    version?: string;
    file_sha256?: string;
    runtime_hint?: XRegistryRuntimeHint;
    packagexid?: string;
    transport: XRegistryTransport;
    runtime_arguments?: XRegistryInputDescriptor[];
    package_arguments?: XRegistryInputDescriptor[];
    environment_variables?: XRegistryNamedInputDescriptor[];
}

export interface XRegistryRepository {
    url: string;
    source: string;
    id?: string;
    subfolder?: string;
}

export interface XRegistryIcon {
    src: string;
    mime_type?: string;
    sizes?: string[];
    theme?: 'light' | 'dark';
}

export interface ServerMetaAttributes {
    status?: 'active' | 'deprecated' | 'deleted';
    status_message?: string;
    status_changed_at?: string;
    published_at?: string;
    updated_at?: string;
    is_latest?: boolean;
}

export interface ServerResourceMeta extends ServerMetaAttributes {
    self: string;
    xid: string;
    epoch: number;
    createdat: string;
    modifiedat: string;
    readonly: boolean;
    defaultversionid: string;
    defaultversionurl: string;
    defaultversionsticky: boolean;
}

export interface ServerVersionMetadata {
    serverid: string;
    versionid: string;
    self: string;
    xid: string;
    epoch: number;
    name?: string;
    title?: string;
    description?: string;
    documentation?: string;
    labels?: Record<string, string>;
    createdat: string;
    modifiedat: string;
    ancestor?: string;
    schemaurl?: string;
    version?: string;
    website_url?: string;
    icons?: XRegistryIcon[];
    packages?: XRegistryPackage[];
    remotes?: XRegistryRemote[];
    repository?: XRegistryRepository;
    publisher_meta?: Record<string, JSONValue>;
}

export interface ServerMetadata extends ServerVersionMetadata {
    metaurl?: string;
    meta?: ServerResourceMeta;
    versionsurl?: string;
    versionscount?: number;
    versions?: Record<string, ServerVersionMetadata>;
}

export interface ProviderMetadata {
    mcpproviderid: string;
    self: string;
    xid: string;
    epoch: number;
    name?: string;
    description?: string;
    documentation?: string;
    labels?: Record<string, string>;
    createdat: string;
    modifiedat: string;
    serversurl: string;
    serverscount: number;
    servers?: Record<string, ServerMetadata>;
}

export interface RegistryMetadata {
    specversion: string;
    registryid: string;
    self: string;
    xid: string;
    epoch: number;
    name?: string;
    description?: string;
    documentation?: string;
    labels?: Record<string, string>;
    createdat: string;
    modifiedat: string;
    mcpprovidersurl: string;
    mcpproviderscount: number;
    mcpproviders?: Record<string, ProviderMetadata>;
}
