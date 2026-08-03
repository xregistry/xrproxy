/**
 * Maven Central API Types
 * @fileoverview Type definitions for Maven Central API responses and data structures
 */

export interface MavenSearchResponse {
    responseHeader: {
        status: number;
        QTime: number;
        params: Record<string, string>;
    };
    response: {
        numFound: number;
        start: number;
        docs: MavenArtifactDoc[];
    };
    facet_counts?: {
        facet_fields?: Record<string, Array<string | number>>;
    };
}

export interface MavenArtifactDoc {
    id: string;
    g: string;
    a: string;
    v?: string;
    latestVersion: string;
    repositoryId: string;
    p: string;
    timestamp: number;
    versionCount: number;
    text?: string[];
    ec?: string[];
}

export interface MavenArtifactMetadata {
    groupId: string;
    artifactId: string;
    versioning?: {
        latest?: string;
        release?: string;
        versions?: {
            version?: string[] | string;
        };
        lastUpdated?: string;
    };
}

export interface MavenCoordinates {
    groupId: string;
    artifactId: string;
    version?: string;
    packaging?: string;
    classifier?: string;
}

export interface MavenSearchQuery {
    q?: string;
    g?: string;
    a?: string;
    v?: string;
    p?: string;
    c?: string;
    rows?: number;
    start?: number;
    core?: string;
    wt?: string;
}

export interface CachedPackageMetadata {
    data: unknown;
    timestamp: number;
    etag?: string;
}

export interface MavenOrganization {
    name?: string;
    url?: string;
}

export interface MavenDeveloper {
    id?: string;
    name?: string;
    email?: string;
    url?: string;
}

export interface MavenLicense {
    name?: string;
    url?: string;
    distribution?: string;
    comments?: string;
}

export interface MavenScm {
    url?: string;
    connection?: string;
    developer_connection?: string;
}

export interface MavenIssueManagement {
    system?: string;
    url?: string;
}

export interface MavenExclusion {
    group_id?: string;
    artifact_id?: string;
}

export interface MavenParentReference {
    group_id?: string;
    artifact_id?: string;
    version?: string;
    relative_path?: string;
    package?: string;
}

export interface MavenDependency {
    group_id: string;
    artifact_id: string;
    version?: string;
    classifier?: string;
    type?: string;
    scope?: string;
    optional?: boolean;
    system_path?: string;
    exclusions?: MavenExclusion[];
    resolved_version?: string;
    managed?: boolean;
    package?: string;
}

export interface MavenProfile {
    id?: string;
    active_by_default?: boolean;
    activation_jdk?: string;
    activation_os?: string;
    activation_property?: string;
    activation_file?: string;
    applied?: boolean;
}

export interface MavenChecksum {
    filename: string;
    classifier?: string;
    extension?: string;
    url?: string;
    size?: number;
    sha1?: string;
    md5?: string;
    sha256?: string;
    sha512?: string;
}

export interface MavenSignature {
    filename: string;
    url?: string;
    format?: string;
    key_id?: string;
    verified?: boolean;
}

export interface MavenResolvedVersion {
    groupId: string;
    artifactId: string;
    version: string;
    versionId: string;
    createdAt?: string;
    modifiedAt?: string;
    packaging?: string;
    classifier?: string;
    classifiers?: string[];
    snapshot?: boolean;
    pom_resolution?: 'raw' | 'effective';
    name?: string;
    description?: string;
    homepage?: string;
    parent?: MavenParentReference;
    modules?: string[];
    properties?: Record<string, string>;
    profiles?: MavenProfile[];
    checksums?: MavenChecksum[];
    signatures?: MavenSignature[];
    organization?: MavenOrganization;
    developers?: MavenDeveloper[];
    licenses?: MavenLicense[];
    scm?: MavenScm;
    issue_management?: MavenIssueManagement;
    dependencies?: MavenDependency[];
    dependency_management?: MavenDependency[];
}
