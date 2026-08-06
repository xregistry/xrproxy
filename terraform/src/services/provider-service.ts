/** Terraform provider Resource, Meta and Version serializers. */

import { UpstreamError } from '@xregistry/registry-core';
import { EntityStateManager } from '../../../shared/entity-state-manager';
import { decodeProviderIdentity, encodeVersionId, REGISTRY_METADATA, TERRAFORM_API } from '../config/constants';
import { ProviderPlatformDistribution, TFProviderVersionSummary } from '../types/terraform';
import { entityNotFound } from '../utils/xregistry-errors';
import { predecessorOf, sortTerraformVersionObjects } from '../utils/versions';
import { TerraformService } from './terraform-service';

type ResolvedProvider = {
    namespace: string;
    type: string;
    versionsResp: Awaited<ReturnType<TerraformService['fetchProviderVersions']>>;
};

type ProviderMetadata = Awaited<ReturnType<TerraformService['fetchProviderV2Attributes']>>;

export class ProviderService {
    constructor(
        private readonly tfService: TerraformService,
        private readonly entityState: EntityStateManager,
    ) {}

    private async resolveProvider(namespaceId: string, providerId: string): Promise<ResolvedProvider> {
        const requested = decodeProviderIdentity(namespaceId, providerId);
        if (!requested) throw entityNotFound(`/${REGISTRY_METADATA.PROVIDER_RESOURCE_TYPE}/${providerId}`, 'provider', providerId);
        const versionsResp = await this.tfService.fetchProviderVersions(requested.namespace, requested.type);
        const parts = versionsResp.id.split('/');
        const canonical = parts.length === 2 ? decodeProviderIdentity(parts[0] ?? '', parts[1] ?? '') : null;
        if (!canonical) {
            throw new UpstreamError({
                code: 'invalid_response',
                message: `Terraform returned an invalid provider identity: ${versionsResp.id}`,
            });
        }
        if (
            (canonical.namespace.toLowerCase() === requested.namespace.toLowerCase() && canonical.namespace !== requested.namespace) ||
            (canonical.type.toLowerCase() === requested.type.toLowerCase() && canonical.type !== requested.type)
        ) {
            throw entityNotFound(`/${REGISTRY_METADATA.GROUP_TYPE}/${namespaceId}/${REGISTRY_METADATA.PROVIDER_RESOURCE_TYPE}/${providerId}`, 'provider', providerId);
        }
        return { ...canonical, versionsResp };
    }

    private versionEntity(
        resolved: ResolvedProvider,
        version: TFProviderVersionSummary,
        orderedVersions: readonly string[],
        baseUrl: string,
        metadata: ProviderMetadata,
        platforms: readonly ProviderPlatformDistribution[] = version.platforms.map(platform => ({ os: platform.os, arch: platform.arch })),
    ): Record<string, unknown> {
        const { GROUP_TYPE, PROVIDER_RESOURCE_TYPE } = REGISTRY_METADATA;
        const versionId = encodeVersionId(version.version);
        const versionPath = `/${GROUP_TYPE}/${resolved.namespace}/${PROVIDER_RESOURCE_TYPE}/${resolved.type}/versions/${versionId}`;
        return {
            versionid: versionId,
            providerid: resolved.type,
            xid: versionPath,
            self: `${baseUrl}/${GROUP_TYPE}/${encodeURIComponent(resolved.namespace)}/${PROVIDER_RESOURCE_TYPE}/${encodeURIComponent(resolved.type)}/versions/${encodeURIComponent(versionId)}`,
            epoch: this.entityState.getEpoch(versionPath),
            createdat: this.entityState.getCreatedAt(versionPath),
            modifiedat: this.entityState.getModifiedAt(versionPath),
            name: resolved.type,
            version: version.version,
            ...(metadata?.description !== undefined ? { description: metadata.description } : {}),
            namespace: resolved.namespace,
            type: resolved.type,
            source: `${resolved.namespace}/${resolved.type}`,
            sourceurl: TERRAFORM_API.REGISTRY_URL,
            isdefault: version.version === orderedVersions.at(-1),
            ancestor: encodeVersionId(predecessorOf([...orderedVersions], version.version)),
            protocols: version.protocols,
            platforms,
        };
    }

    async getProviderMetadata(namespaceId: string, providerId: string, baseUrl: string): Promise<Record<string, unknown>> {
        const resolved = await this.resolveProvider(namespaceId, providerId);
        const versions = sortTerraformVersionObjects(resolved.versionsResp.versions ?? []);
        const selected = versions.at(-1);
        if (!selected) throw entityNotFound(`/${REGISTRY_METADATA.PROVIDER_RESOURCE_TYPE}/${providerId}`, 'provider', providerId);
        const metadata = await this.tfService.fetchProviderV2Attributes(resolved.namespace, resolved.type);
        const orderedVersions = versions.map(version => version.version);
        const projected = this.versionEntity(resolved, selected, orderedVersions, baseUrl, metadata);
        const { GROUP_TYPE, PROVIDER_RESOURCE_TYPE } = REGISTRY_METADATA;
        const resourcePath = `/${GROUP_TYPE}/${resolved.namespace}/${PROVIDER_RESOURCE_TYPE}/${resolved.type}`;
        const resourceBaseUrl = `${baseUrl}/${GROUP_TYPE}/${encodeURIComponent(resolved.namespace)}/${PROVIDER_RESOURCE_TYPE}/${encodeURIComponent(resolved.type)}`;
        return {
            ...projected,
            providerid: resolved.type,
            xid: resourcePath,
            self: resourceBaseUrl,
            metaurl: `${resourceBaseUrl}/meta`,
            versionsurl: `${resourceBaseUrl}/versions`,
            versionscount: versions.length,
        };
    }

    async getProviderMeta(namespaceId: string, providerId: string, baseUrl: string): Promise<Record<string, unknown>> {
        const resolved = await this.resolveProvider(namespaceId, providerId);
        const versions = sortTerraformVersionObjects(resolved.versionsResp.versions ?? []);
        const latestVersion = versions.at(-1)?.version;
        if (!latestVersion) throw entityNotFound(`/${REGISTRY_METADATA.PROVIDER_RESOURCE_TYPE}/${providerId}`, 'provider', providerId);
        const metadata = await this.tfService.fetchProviderV2Attributes(resolved.namespace, resolved.type);
        const { GROUP_TYPE, PROVIDER_RESOURCE_TYPE } = REGISTRY_METADATA;
        const metaPath = `/${GROUP_TYPE}/${resolved.namespace}/${PROVIDER_RESOURCE_TYPE}/${resolved.type}/meta`;
        const resourceBaseUrl = `${baseUrl}/${GROUP_TYPE}/${encodeURIComponent(resolved.namespace)}/${PROVIDER_RESOURCE_TYPE}/${encodeURIComponent(resolved.type)}`;
        return {
            providerid: resolved.type,
            xid: metaPath,
            self: `${resourceBaseUrl}/meta`,
            epoch: this.entityState.getEpoch(metaPath),
            createdat: this.entityState.getCreatedAt(metaPath),
            modifiedat: this.entityState.getModifiedAt(metaPath),
            readonly: true,
            compatibility: 'none',
            defaultversionid: encodeVersionId(latestVersion),
            defaultversionurl: `${resourceBaseUrl}/versions/${encodeURIComponent(encodeVersionId(latestVersion))}`,
            defaultversionsticky: false,
            ...(metadata?.downloads !== undefined ? { downloads: metadata.downloads } : {}),
            ...(metadata?.tier !== undefined ? { tier: metadata.tier } : {}),
            ...(metadata?.logo_url !== undefined ? { logo_url: metadata.logo_url } : {}),
            ...(metadata?.categories !== undefined ? { categories: metadata.categories } : {}),
            ...(metadata?.featured !== undefined ? { featured: metadata.featured } : {}),
            ...(metadata?.unlisted !== undefined ? { unlisted: metadata.unlisted } : {}),
            ...(metadata?.warning !== undefined ? { warning: metadata.warning } : {}),
            ...(metadata?.aliases !== undefined ? { aliases: metadata.aliases } : {}),
        };
    }

    async getProviderVersions(namespaceId: string, providerId: string, baseUrl: string): Promise<Record<string, unknown>> {
        const resolved = await this.resolveProvider(namespaceId, providerId);
        const versions = sortTerraformVersionObjects(resolved.versionsResp.versions ?? []);
        const orderedVersions = versions.map(version => version.version);
        const metadata = await this.tfService.fetchProviderV2Attributes(resolved.namespace, resolved.type);
        return Object.fromEntries(versions.map(version => [
            encodeVersionId(version.version),
            this.versionEntity(resolved, version, orderedVersions, baseUrl, metadata),
        ]));
    }

    async getProviderVersion(namespaceId: string, providerId: string, versionId: string, baseUrl: string): Promise<Record<string, unknown>> {
        const resolved = await this.resolveProvider(namespaceId, providerId);
        const versions = sortTerraformVersionObjects(resolved.versionsResp.versions ?? []);
        const orderedVersions = versions.map(version => version.version);
        const requestedVersion = versionId.replace(/~/g, '+');
        const summary = versions.find(version => version.version === requestedVersion);
        if (!summary) {
            throw entityNotFound(`/${REGISTRY_METADATA.GROUP_TYPE}/${resolved.namespace}/${REGISTRY_METADATA.PROVIDER_RESOURCE_TYPE}/${resolved.type}/versions/${versionId}`, 'version', versionId);
        }
        const metadata = await this.tfService.fetchProviderV2Attributes(resolved.namespace, resolved.type);
        const platforms = await this.fetchPlatformDistributions(resolved.namespace, resolved.type, requestedVersion, summary);
        return this.versionEntity(resolved, summary, orderedVersions, baseUrl, metadata, platforms);
    }

    private async fetchPlatformDistributions(
        namespace: string,
        type: string,
        version: string,
        summary: TFProviderVersionSummary,
    ): Promise<ProviderPlatformDistribution[]> {
        const enriched = await Promise.all(summary.platforms.map(async platform => {
            const download = await this.tfService.fetchProviderPlatformDownload(namespace, type, version, platform.os, platform.arch);
            if (!download) {
                return { os: platform.os, arch: platform.arch } satisfies ProviderPlatformDistribution;
            }
            return {
                os: platform.os,
                arch: platform.arch,
                protocols: download.protocols,
                filename: download.filename,
                download_url: download.download_url,
                shasums_url: download.shasums_url,
                shasums_signature_url: download.shasums_signature_url,
                shasum: download.shasum,
                signing_keys: download.signing_keys,
            } satisfies ProviderPlatformDistribution;
        }));
        return enriched.sort((a, b) => a.os.localeCompare(b.os) || a.arch.localeCompare(b.arch));
    }
}
