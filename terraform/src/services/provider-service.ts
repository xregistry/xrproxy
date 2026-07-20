/** Terraform provider Resource, Meta and Version serializers. */

import { UpstreamError } from '@xregistry/registry-core';
import { EntityStateManager } from '../../../shared/entity-state-manager';
import { decodeProviderIdentity, REGISTRY_METADATA } from '../config/constants';
import { ProviderPlatformDistribution, TFGPGKey, TFProviderDownloadResponse, TFProviderVersionSummary } from '../types/terraform';
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
        orderedIds: readonly string[],
        baseUrl: string,
        metadata: ProviderMetadata,
        platforms: readonly unknown[] = version.platforms,
        signingKeys?: { gpg_public_keys: TFGPGKey[] },
    ): Record<string, unknown> {
        const { GROUP_TYPE, REGISTRY_HOST, PROVIDER_RESOURCE_TYPE } = REGISTRY_METADATA;
        const versionPath = `/${GROUP_TYPE}/${resolved.namespace}/${PROVIDER_RESOURCE_TYPE}/${resolved.type}/versions/${version.version}`;
        return {
            versionid: version.version,
            providerid: resolved.type,
            xid: versionPath,
            self: `${baseUrl}/${GROUP_TYPE}/${encodeURIComponent(resolved.namespace)}/${PROVIDER_RESOURCE_TYPE}/${encodeURIComponent(resolved.type)}/versions/${encodeURIComponent(version.version)}`,
            epoch: this.entityState.getEpoch(versionPath),
            createdat: this.entityState.getCreatedAt(versionPath),
            modifiedat: this.entityState.getModifiedAt(versionPath),
            name: `${resolved.namespace}/${resolved.type}`,
            description: metadata?.description ?? '',
            namespace: resolved.namespace,
            type: resolved.type,
            source: `${resolved.namespace}/${resolved.type}`,
            registryhost: REGISTRY_HOST,
            isdefault: version.version === orderedIds.at(-1),
            ancestor: predecessorOf([...orderedIds], version.version),
            protocols: version.protocols,
            platforms,
            ...(signingKeys === undefined ? {} : { signing_keys: signingKeys }),
        };
    }

    async getProviderMetadata(namespaceId: string, providerId: string, baseUrl: string): Promise<Record<string, unknown>> {
        const resolved = await this.resolveProvider(namespaceId, providerId);
        const versions = sortTerraformVersionObjects(resolved.versionsResp.versions ?? []);
        const selected = versions.at(-1);
        if (!selected) throw entityNotFound(`/${REGISTRY_METADATA.PROVIDER_RESOURCE_TYPE}/${providerId}`, 'provider', providerId);
        const metadata = await this.tfService.fetchProviderV2Attributes(resolved.namespace, resolved.type);
        const versionIds = versions.map(version => version.version);
        const projected = this.versionEntity(resolved, selected, versionIds, baseUrl, metadata);
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
            defaultversionid: latestVersion,
            defaultversionurl: `${resourceBaseUrl}/versions/${encodeURIComponent(latestVersion)}`,
            defaultversionsticky: false,
            downloads: metadata?.downloads ?? 0,
            tier: metadata?.tier ?? 'community',
            logo_url: metadata?.logo_url ?? '',
            categories: metadata?.categories ?? [],
            featured: metadata?.featured ?? false,
            unlisted: metadata?.unlisted ?? false,
            ...(metadata?.warning ? { warning: metadata.warning } : {}),
            ...(metadata?.aliases?.length ? { aliases: metadata.aliases } : {}),
        };
    }

    async getProviderVersions(namespaceId: string, providerId: string, baseUrl: string): Promise<Record<string, unknown>> {
        const resolved = await this.resolveProvider(namespaceId, providerId);
        const versions = sortTerraformVersionObjects(resolved.versionsResp.versions ?? []);
        const versionIds = versions.map(version => version.version);
        const metadata = await this.tfService.fetchProviderV2Attributes(resolved.namespace, resolved.type);
        return Object.fromEntries(versions.map(version => [
            version.version,
            this.versionEntity(resolved, version, versionIds, baseUrl, metadata),
        ]));
    }

    async getProviderVersion(namespaceId: string, providerId: string, versionId: string, baseUrl: string): Promise<Record<string, unknown>> {
        const resolved = await this.resolveProvider(namespaceId, providerId);
        const versions = sortTerraformVersionObjects(resolved.versionsResp.versions ?? []);
        const versionIds = versions.map(version => version.version);
        const summary = versions.find(version => version.version === versionId);
        if (!summary) {
            throw entityNotFound(`/${REGISTRY_METADATA.GROUP_TYPE}/${resolved.namespace}/${REGISTRY_METADATA.PROVIDER_RESOURCE_TYPE}/${resolved.type}/versions/${versionId}`, 'version', versionId);
        }
        const metadata = await this.tfService.fetchProviderV2Attributes(resolved.namespace, resolved.type);
        const platforms = await this.fetchPlatformDistributions(resolved.namespace, resolved.type, versionId, summary);
        return this.versionEntity(
            resolved,
            summary,
            versionIds,
            baseUrl,
            metadata,
            platforms.enriched,
            this.extractSigningKeys(platforms.raw),
        );
    }

    private async fetchPlatformDistributions(
        namespace: string,
        type: string,
        version: string,
        summary: TFProviderVersionSummary,
    ): Promise<{ enriched: ProviderPlatformDistribution[]; raw: TFProviderDownloadResponse[] }> {
        const raw: TFProviderDownloadResponse[] = [];
        const enriched: ProviderPlatformDistribution[] = [];
        await Promise.all(summary.platforms.map(async platform => {
            const download = await this.tfService.fetchProviderPlatformDownload(namespace, type, version, platform.os, platform.arch);
            if (download) {
                raw.push(download);
                enriched.push({
                    os: platform.os,
                    arch: platform.arch,
                    filename: download.filename,
                    download_url: download.download_url,
                    shasums_url: download.shasums_url,
                    shasums_signature_url: download.shasums_signature_url,
                    shasum: download.shasum,
                });
            } else {
                enriched.push({
                    os: platform.os,
                    arch: platform.arch,
                    filename: '',
                    download_url: '',
                    shasums_url: '',
                    shasums_signature_url: '',
                    shasum: '',
                });
            }
        }));
        enriched.sort((a, b) => a.os.localeCompare(b.os) || a.arch.localeCompare(b.arch));
        return { enriched, raw };
    }

    private extractSigningKeys(rawDownloads: TFProviderDownloadResponse[]): { gpg_public_keys: TFGPGKey[] } {
        const seen = new Set<string>();
        const keys: TFGPGKey[] = [];
        for (const download of rawDownloads) {
            for (const key of download.signing_keys?.gpg_public_keys ?? []) {
                if (!seen.has(key.key_id)) {
                    seen.add(key.key_id);
                    keys.push(key);
                }
            }
        }
        return { gpg_public_keys: keys };
    }
}
