/** Terraform module Resource, Meta and Version serializers. */

import { UpstreamError } from '@xregistry/registry-core';
import { EntityStateManager } from '../../../shared/entity-state-manager';
import { decodeModuleIdentity, encodeModuleId, encodeVersionId, REGISTRY_METADATA, TERRAFORM_API } from '../config/constants';
import { TFModuleVersionDetail } from '../types/terraform';
import { entityNotFound } from '../utils/xregistry-errors';
import { predecessorOf, sortTerraformVersions } from '../utils/versions';
import { TerraformService } from './terraform-service';

type ResolvedModule = {
    namespace: string;
    name: string;
    provider: string;
    moduleId: string;
    versionsResp: Awaited<ReturnType<TerraformService['fetchModuleVersions']>>;
};

type ModuleProjectionData = {
    detail: Partial<TFModuleVersionDetail>;
    downloadUrl: string | null;
};

export class ModuleService {
    constructor(
        private readonly tfService: TerraformService,
        private readonly entityState: EntityStateManager,
    ) {}

    private async resolveModule(namespaceId: string, moduleId: string): Promise<ResolvedModule> {
        const requested = decodeModuleIdentity(namespaceId, moduleId);
        if (!requested) throw entityNotFound(`/${REGISTRY_METADATA.MODULE_RESOURCE_TYPE}/${moduleId}`, 'module', moduleId);
        const versionsResp = await this.tfService.fetchModuleVersions(requested.namespace, requested.name, requested.provider);
        const source = versionsResp.modules?.[0]?.source;
        const parts = source?.split('/') ?? [];
        const canonicalId = parts.length === 3 ? encodeModuleId(parts[0] ?? '', parts[1] ?? '', parts[2] ?? '') : '';
        const canonical = parts.length === 3 ? decodeModuleIdentity(parts[0] ?? '', canonicalId) : null;
        if (!canonical) {
            if (!source) {
                throw new UpstreamError({ code: 'not_found', status: 404, message: `Module ${requested.namespace}/${requested.name}/${requested.provider} not found` });
            }
            throw new UpstreamError({ code: 'invalid_response', message: `Terraform returned an invalid module identity: ${source}` });
        }
        if (
            (canonical.namespace.toLowerCase() === requested.namespace.toLowerCase() && canonical.namespace !== requested.namespace) ||
            (canonical.name.toLowerCase() === requested.name.toLowerCase() && canonical.name !== requested.name) ||
            (canonical.provider.toLowerCase() === requested.provider.toLowerCase() && canonical.provider !== requested.provider)
        ) {
            throw entityNotFound(`/${REGISTRY_METADATA.GROUP_TYPE}/${namespaceId}/${REGISTRY_METADATA.MODULE_RESOURCE_TYPE}/${moduleId}`, 'module', moduleId);
        }
        return { ...canonical, moduleId: canonicalId, versionsResp };
    }

    private async versionProjectionData(resolved: ResolvedModule, version: string): Promise<ModuleProjectionData> {
        const [detail, downloadUrl] = await Promise.all([
            this.versionDetail(resolved, version),
            this.tfService.fetchModuleDownloadUrl(resolved.namespace, resolved.name, resolved.provider, version),
        ]);
        return { detail, downloadUrl };
    }

    private versionEntity(
        resolved: ResolvedModule,
        version: string,
        versions: readonly string[],
        baseUrl: string,
        projection: ModuleProjectionData,
    ): Record<string, unknown> {
        const { GROUP_TYPE, MODULE_RESOURCE_TYPE } = REGISTRY_METADATA;
        const versionId = encodeVersionId(version);
        const versionPath = `/${GROUP_TYPE}/${resolved.namespace}/${MODULE_RESOURCE_TYPE}/${resolved.moduleId}/versions/${versionId}`;
        return {
            versionid: versionId,
            moduleid: resolved.moduleId,
            xid: versionPath,
            self: `${baseUrl}/${GROUP_TYPE}/${encodeURIComponent(resolved.namespace)}/${MODULE_RESOURCE_TYPE}/${encodeURIComponent(resolved.moduleId)}/versions/${encodeURIComponent(versionId)}`,
            epoch: this.entityState.getEpoch(versionPath),
            createdat: projection.detail.published_at ?? this.entityState.getCreatedAt(versionPath),
            modifiedat: this.entityState.getModifiedAt(versionPath),
            namespace: resolved.namespace,
            name: resolved.name,
            version,
            provider: resolved.provider,
            source_address: `${resolved.namespace}/${resolved.name}/${resolved.provider}`,
            sourceurl: TERRAFORM_API.REGISTRY_URL,
            isdefault: version === versions.at(-1),
            ancestor: encodeVersionId(predecessorOf([...versions], version)),
            ...(projection.detail.id !== undefined ? { id: projection.detail.id } : {}),
            ...(projection.detail.description !== undefined ? { description: projection.detail.description } : {}),
            ...(projection.detail.source !== undefined ? { source: projection.detail.source } : {}),
            ...(projection.downloadUrl !== null ? { download_url: projection.downloadUrl } : {}),
            ...(projection.detail.published_at !== undefined ? { published_at: projection.detail.published_at } : {}),
            ...(projection.detail.providers !== undefined ? { providers: projection.detail.providers } : {}),
            versions,
            ...(projection.detail.root !== undefined ? { root: projection.detail.root } : {}),
            ...(projection.detail.submodules !== undefined ? { submodules: projection.detail.submodules } : {}),
        };
    }

    private async versionDetail(resolved: ResolvedModule, version: string): Promise<Partial<TFModuleVersionDetail>> {
        try {
            return await this.tfService.fetchModuleVersion(resolved.namespace, resolved.name, resolved.provider, version);
        } catch (error) {
            if (error instanceof UpstreamError && error.code === 'not_found') return {};
            throw error;
        }
    }

    async getModuleMetadata(namespaceId: string, moduleId: string, baseUrl: string): Promise<Record<string, unknown>> {
        const resolved = await this.resolveModule(namespaceId, moduleId);
        const versions = sortTerraformVersions(resolved.versionsResp.modules?.[0]?.versions?.map(version => version.version) ?? []);
        const selected = versions.at(-1);
        if (!selected) throw entityNotFound(`/${REGISTRY_METADATA.MODULE_RESOURCE_TYPE}/${moduleId}`, 'module', moduleId);
        const projected = this.versionEntity(resolved, selected, versions, baseUrl, await this.versionProjectionData(resolved, selected));
        const { GROUP_TYPE, MODULE_RESOURCE_TYPE } = REGISTRY_METADATA;
        const resourcePath = `/${GROUP_TYPE}/${resolved.namespace}/${MODULE_RESOURCE_TYPE}/${resolved.moduleId}`;
        const resourceBaseUrl = `${baseUrl}/${GROUP_TYPE}/${encodeURIComponent(resolved.namespace)}/${MODULE_RESOURCE_TYPE}/${encodeURIComponent(resolved.moduleId)}`;
        return {
            ...projected,
            moduleid: resolved.moduleId,
            xid: resourcePath,
            self: resourceBaseUrl,
            metaurl: `${resourceBaseUrl}/meta`,
            versionsurl: `${resourceBaseUrl}/versions`,
            versionscount: versions.length,
        };
    }

    async getModuleMeta(namespaceId: string, moduleId: string, baseUrl: string): Promise<Record<string, unknown>> {
        const resolved = await this.resolveModule(namespaceId, moduleId);
        const versions = sortTerraformVersions(resolved.versionsResp.modules?.[0]?.versions?.map(version => version.version) ?? []);
        const latestVersion = versions.at(-1);
        if (!latestVersion) throw entityNotFound(`/${REGISTRY_METADATA.MODULE_RESOURCE_TYPE}/${moduleId}`, 'module', moduleId);
        const aggregate = await this.tfService.fetchModuleSearchEntry(resolved.namespace, resolved.name, resolved.provider);
        const { GROUP_TYPE, MODULE_RESOURCE_TYPE } = REGISTRY_METADATA;
        const metaPath = `/${GROUP_TYPE}/${resolved.namespace}/${MODULE_RESOURCE_TYPE}/${resolved.moduleId}/meta`;
        const resourceBaseUrl = `${baseUrl}/${GROUP_TYPE}/${encodeURIComponent(resolved.namespace)}/${MODULE_RESOURCE_TYPE}/${encodeURIComponent(resolved.moduleId)}`;
        const defaultVersionId = encodeVersionId(latestVersion);
        return {
            moduleid: resolved.moduleId,
            xid: metaPath,
            self: `${resourceBaseUrl}/meta`,
            epoch: this.entityState.getEpoch(metaPath),
            createdat: this.entityState.getCreatedAt(metaPath),
            modifiedat: this.entityState.getModifiedAt(metaPath),
            readonly: true,
            compatibility: 'none',
            defaultversionid: defaultVersionId,
            defaultversionurl: `${resourceBaseUrl}/versions/${encodeURIComponent(defaultVersionId)}`,
            defaultversionsticky: false,
            ...(aggregate?.downloads !== undefined ? { downloads: aggregate.downloads } : {}),
            ...(aggregate?.verified !== undefined ? { verified: aggregate.verified } : {}),
            ...(aggregate?.owner !== undefined ? { owner: aggregate.owner } : {}),
            ...(aggregate?.trusted !== undefined ? { trusted: aggregate.trusted } : {}),
        };
    }

    async getModuleVersions(namespaceId: string, moduleId: string, baseUrl: string): Promise<Record<string, unknown>> {
        const resolved = await this.resolveModule(namespaceId, moduleId);
        const versions = sortTerraformVersions(resolved.versionsResp.modules?.[0]?.versions?.map(version => version.version) ?? []);
        const projected = await Promise.all(versions.map(async version => [
            encodeVersionId(version),
            this.versionEntity(resolved, version, versions, baseUrl, await this.versionProjectionData(resolved, version)),
        ] as const));
        return Object.fromEntries(projected);
    }

    async getModuleVersion(namespaceId: string, moduleId: string, versionId: string, baseUrl: string): Promise<Record<string, unknown>> {
        const resolved = await this.resolveModule(namespaceId, moduleId);
        const versions = sortTerraformVersions(resolved.versionsResp.modules?.[0]?.versions?.map(version => version.version) ?? []);
        const requestedVersion = versionId.replace(/~/g, '+');
        if (!versions.includes(requestedVersion)) {
            throw entityNotFound(`/${REGISTRY_METADATA.GROUP_TYPE}/${resolved.namespace}/${REGISTRY_METADATA.MODULE_RESOURCE_TYPE}/${resolved.moduleId}/versions/${versionId}`, 'version', versionId);
        }
        return this.versionEntity(resolved, requestedVersion, versions, baseUrl, await this.versionProjectionData(resolved, requestedVersion));
    }
}
