export interface OCICatalogResponse {
    repositories?: string[];
}

export interface OCITagsResponse {
    name?: string;
    tags?: string[];
}

export interface OCIManifest {
    schemaVersion?: number;
    mediaType?: string;
    config?: OCIDescriptor;
    layers?: OCIDescriptor[];
    manifests?: OCIDescriptor[];
    annotations?: Record<string, string>;
    artifactType?: string;
    subject?: OCIDescriptor;
}

export interface OCIDescriptor {
    mediaType?: string;
    digest: string;
    size?: number;
    urls?: string[];
    annotations?: Record<string, string>;
    data?: string;
    artifactType?: string;
    platform?: OCIPlatform;
}

export interface OCIPlatform {
    architecture?: string;
    os?: string;
    'os.version'?: string;
    'os.features'?: string[];
    variant?: string;
}

export interface OCIImageConfig {
    created?: string;
    author?: string;
    architecture?: string;
    os?: string;
    variant?: string;
    'os.version'?: string;
    'os.features'?: string[];
    config?: OCIContainerConfig;
    rootfs?: OCIRootFS;
    history?: OCIHistoryEntry[];
}

export interface OCIContainerConfig {
    User?: string;
    ExposedPorts?: Record<string, object>;
    Env?: string[];
    Entrypoint?: string[];
    Cmd?: string[];
    Volumes?: Record<string, object>;
    WorkingDir?: string;
    Labels?: Record<string, string>;
    StopSignal?: string;
}

export interface OCIRootFS {
    type?: string;
    diff_ids?: string[];
}

export interface OCIHistoryEntry {
    created?: string;
    created_by?: string;
    author?: string;
    comment?: string;
    empty_layer?: boolean;
}

export interface OCIBackend {
    id: string;
    name: string;
    url: string;
    apiVersion: string;
    description?: string;
    enabled: boolean;
    public: boolean;
    username?: string;
    password?: string;
    token?: string;
    registry?: string;
    authUrl?: string;
    catalogPath?: string;
}

export interface DockerAuthTokenResponse {
    token?: string;
    access_token?: string;
    expires_in?: number;
    issued_at?: string;
}
