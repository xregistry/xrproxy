/**
 * TypeScript definitions for the xRegistry views produced by the Maven service.
 */

export interface XRegistryEntity {
    xid: string;
    self: string;
    epoch: number;
    createdat?: string;
    modifiedat?: string;
    name?: string;
    description?: string;
    documentation?: string;
    labels?: Record<string, string>;
    shortself?: string;
    [key: string]: unknown;
}

export interface Registry extends XRegistryEntity {
    specversion: string;
    registryid: string;
    capabilitiesurl: string;
    modelurl: string;
    javanamespacesurl: string;
    javanamespacescount: number;
    javanamespaces?: Record<string, Group>;
}

export interface Group extends XRegistryEntity {
    javanamespaceid: string;
    group_id: string;
    sourceurl?: string;
    packagesurl: string;
    packagescount: number;
}

export interface Resource extends XRegistryEntity {
    packageid: string;
    versionid?: string;
    version?: string;
    ancestor?: string;
    metaurl?: string;
    versionsurl?: string;
    versionscount?: number;
    group_id: string;
    artifact_id: string;
    packaging?: string;
    classifier?: string;
    classifiers?: string[];
    snapshot?: boolean;
    pom_resolution?: 'raw' | 'effective';
    homepage?: string;
    parent?: unknown;
    modules?: string[];
    properties?: Record<string, string>;
    profiles?: unknown[];
    checksums?: unknown[];
    signatures?: unknown[];
    organization?: unknown;
    developers?: unknown[];
    licenses?: unknown[];
    scm?: unknown;
    issue_management?: unknown;
    dependencies?: unknown[];
    dependency_management?: unknown[];
}

export interface Version extends XRegistryEntity {
    versionid: string;
    version?: string;
    ancestor?: string;
}

export interface Meta extends XRegistryEntity {
    readonly: boolean;
    defaultversionid?: string;
    defaultversionurl?: string;
    defaultversionsticky?: boolean;
}

export interface ErrorResponse {
    type: string;
    title: string;
    status: number;
    instance: string;
    detail?: string;
    data?: unknown;
}
