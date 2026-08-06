export interface XRegistryEntity {
    xid: string;
    self: string;
    epoch: number;
    createdat: string;
    modifiedat: string;
    name?: string;
    description?: string;
    documentation?: string;
    labels?: Record<string, string>;
    shortself?: string;
    icon?: string;
    [key: string]: unknown;
}

export interface Registry extends XRegistryEntity {
    specversion: string;
    registryid: string;
    containerregistriesurl: string;
    containerregistriescount: number;
    containerregistries?: Record<string, ContainerRegistryGroup>;
    capabilitiesurl?: string;
    capabilities?: Record<string, unknown>;
    modelurl?: string;
    model?: Record<string, unknown>;
}

export interface Group extends XRegistryEntity {
    [key: string]: unknown;
}

export interface Resource extends XRegistryEntity {
    imageid: string;
    versionid: string;
    isdefault: true;
    versionsurl?: string;
    versionscount?: number;
    versions?: Record<string, VersionMetadata>;
    metaurl?: string;
    meta?: ImageMeta;
}

export interface Version extends XRegistryEntity {
    versionid: string;
    isdefault: boolean;
}

export interface Meta extends XRegistryEntity {
    readonly?: boolean;
    defaultversionid?: string;
    defaultversionurl?: string;
    defaultversionsticky?: boolean;
    deprecated?: {
        effective?: string;
        removal?: string;
        alternative?: string;
        documentation?: string;
    };
}

export interface ErrorResponse {
    type: string;
    title: string;
    status: number;
    instance: string;
    detail?: string;
    data?: unknown;
}

export interface LayerInfo {
    digest: string;
    size?: number;
    mediatype?: string;
}

export interface DescriptorInfo {
    digest: string;
    mediatype?: string;
    size?: number;
}

export interface ReferrerInfo extends DescriptorInfo {
    artifact_type?: string;
    annotations?: Record<string, string>;
}

export interface PlatformInfo {
    architecture: string;
    os: string;
    variant?: string;
    digest: string;
    size?: number;
    mediatype?: string;
}

export interface OciLabelProjection {
    title?: string;
    description?: string;
    version?: string;
    created?: string;
    revision?: string;
    source?: string;
    url?: string;
    documentation?: string;
    licenses?: string;
    vendor?: string;
    authors?: string;
    ref_name?: string;
    base_digest?: string;
    base_name?: string;
}

export interface BuildHistoryEntry {
    step: number;
    created?: string;
    created_by?: string;
    empty_layer?: boolean;
    author?: string;
    comment?: string;
}

export interface OciVersionDetails {
    digest?: string;
    manifest_mediatype?: string;
    artifact_type?: string;
    subject?: DescriptorInfo;
    config?: DescriptorInfo;
    schema_version?: number;
    layers_count?: number;
    architecture?: string;
    os?: string;
    variant?: string;
    os_version?: string;
    os_features?: string[];
    size_bytes?: number;
    is_multi_platform?: boolean;
    available_platforms?: PlatformInfo[];
    oci_labels?: OciLabelProjection;
    environment?: string[];
    working_dir?: string;
    entrypoint?: string[];
    cmd?: string[];
    user?: string;
    stop_signal?: string;
    author?: string;
    rootfs_diff_ids?: string[];
    exposed_ports?: string[];
    volumes?: string[];
}

export interface ImageVersionProjection extends Version {
    annotations?: Record<string, string>;
    config_labels?: Record<string, string>;
    layers?: LayerInfo[];
    build_history?: BuildHistoryEntry[];
    urls?: {
        pull?: string;
        manifest?: string;
        config?: string;
    };
    referrers?: ReferrerInfo[];
    vulnerabilities?: unknown;
    pushed?: string;
    metadata?: OciVersionDetails;
}

export interface ImageMeta extends Meta {
    sourceurl?: string;
    namespace?: string;
    repository?: string;
    pulled?: number;
    starred?: number;
    deprecated_message?: string;
}

export interface ImageMetadata extends Resource {
    annotations?: Record<string, string>;
    config_labels?: Record<string, string>;
    layers?: LayerInfo[];
    build_history?: BuildHistoryEntry[];
    urls?: {
        pull?: string;
        manifest?: string;
        config?: string;
    };
    referrers?: ReferrerInfo[];
    vulnerabilities?: unknown;
    pushed?: string;
    metadata?: OciVersionDetails;
}

export interface VersionMetadata extends ImageVersionProjection {
}

export interface ContainerRegistryGroup extends Group {
    containerregistryid: string;
    sourceurl?: string;
    imagesurl: string;
    imagescount: number;
    images?: Record<string, ImageMetadata>;
}
