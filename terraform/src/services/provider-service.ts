/**
 * Provider Service — builds xRegistry-compliant resource representations
 * for Terraform providers and their versions.
 */

import { EntityStateManager } from '../../../shared/entity-state-manager';
import {
    decodeProviderId,
    encodeProviderId,
    REGISTRY_METADATA,
} from '../config/constants';
import {
    ProviderPlatformDistribution,
    TFGPGKey,
    TFProviderDownloadResponse,
    TFProviderVersionSummary,
} from '../types/terraform';
import { entityNotFound } from '../utils/xregistry-errors';
import { TerraformService } from './terraform-service';

export class ProviderService {
    private tfService: TerraformService;
    private entityState: EntityStateManager;

    constructor(tfService: TerraformService, entityState: EntityStateManager) {
        this.tfService = tfService;
        this.entityState = entityState;
    }

    // -----------------------------------------------------------------------
    // Resource (provider) level
    // -----------------------------------------------------------------------

    async getProviderMetadata(providerId: string, baseUrl: string): Promise<Record<string, unknown>> {
        const decoded = decodeProviderId(providerId);
        if (!decoded) throw entityNotFound(`/${REGISTRY_METADATA.PROVIDER_RESOURCE_TYPE}/${providerId}`, 'provider', providerId);

        const { namespace, type } = decoded;
        const { GROUP_TYPE, GROUP_ID, PROVIDER_RESOURCE_TYPE, PROVIDER_RESOURCE_TYPE_SINGULAR } = REGISTRY_METADATA;

        const versionsResp = await this.tfService.fetchProviderVersions(namespace, type);
        const v2Meta = await this.tfService.fetchProviderV2Attributes(namespace, type);

        const versions = versionsResp.versions ?? [];
        const latestVersion = versions[versions.length - 1]?.version ?? '';

        const resourcePath = `/${GROUP_TYPE}/${GROUP_ID}/${PROVIDER_RESOURCE_TYPE}/${providerId}`;
        const resourceBaseUrl = `${baseUrl}/${GROUP_TYPE}/${GROUP_ID}/${PROVIDER_RESOURCE_TYPE}/${providerId}`;

        return {
            [`${PROVIDER_RESOURCE_TYPE_SINGULAR}id`]: providerId,
            xid: resourcePath,
            self: resourceBaseUrl,
            epoch: this.entityState.getEpoch(resourcePath),
            createdat: this.entityState.getCreatedAt(resourcePath),
            modifiedat: this.entityState.getModifiedAt(resourcePath),
            versionid: latestVersion,
            isdefault: true,
            metaurl: `${resourceBaseUrl}/meta`,
            versionsurl: `${resourceBaseUrl}/versions`,
            versionscount: versions.length,
            // Provider-specific attributes
            namespace,
            type,
            source: encodeProviderId(namespace, type).replace('~', '/'),
            description: v2Meta?.description ?? '',
            downloads: v2Meta?.downloads ?? 0,
            tier: v2Meta?.tier ?? 'community',
            logo_url: v2Meta?.logo_url ?? '',
            categories: v2Meta?.categories ?? [],
            featured: v2Meta?.featured ?? false,
            unlisted: v2Meta?.unlisted ?? false,
            ...(v2Meta?.warning ? { warning: v2Meta.warning } : {}),
            ...(v2Meta?.aliases?.length ? { aliases: v2Meta.aliases } : {}),
        };
    }

    async getProviderMeta(providerId: string, baseUrl: string): Promise<Record<string, unknown>> {
        const decoded = decodeProviderId(providerId);
        if (!decoded) throw entityNotFound(`/${REGISTRY_METADATA.PROVIDER_RESOURCE_TYPE}/${providerId}/meta`, 'provider', providerId);

        const { namespace, type } = decoded;
        const { GROUP_TYPE, GROUP_ID, PROVIDER_RESOURCE_TYPE, PROVIDER_RESOURCE_TYPE_SINGULAR } = REGISTRY_METADATA;

        const versionsResp = await this.tfService.fetchProviderVersions(namespace, type);
        const latestVersion = versionsResp.versions?.[versionsResp.versions.length - 1]?.version ?? '';

        const metaPath = `/${GROUP_TYPE}/${GROUP_ID}/${PROVIDER_RESOURCE_TYPE}/${providerId}/meta`;
        const resourceBaseUrl = `${baseUrl}/${GROUP_TYPE}/${GROUP_ID}/${PROVIDER_RESOURCE_TYPE}/${providerId}`;

        return {
            [`${PROVIDER_RESOURCE_TYPE_SINGULAR}id`]: providerId,
            xid: metaPath,
            self: `${resourceBaseUrl}/meta`,
            epoch: this.entityState.getEpoch(metaPath),
            createdat: this.entityState.getCreatedAt(metaPath),
            modifiedat: this.entityState.getModifiedAt(metaPath),
            readonly: true,
            compatibility: 'none',
            defaultversionid: latestVersion,
            defaultversionurl: `${resourceBaseUrl}/versions/${latestVersion}`,
            defaultversionsticky: true,
        };
    }

    // -----------------------------------------------------------------------
    // Version collection
    // -----------------------------------------------------------------------

    async getProviderVersions(providerId: string, baseUrl: string): Promise<Record<string, unknown>> {
        const decoded = decodeProviderId(providerId);
        if (!decoded) throw entityNotFound(`/${REGISTRY_METADATA.PROVIDER_RESOURCE_TYPE}/${providerId}/versions`, 'provider', providerId);

        const { namespace, type } = decoded;
        const { GROUP_TYPE, GROUP_ID, PROVIDER_RESOURCE_TYPE } = REGISTRY_METADATA;

        const resp = await this.tfService.fetchProviderVersions(namespace, type);
        const versions = resp.versions ?? [];

        const versionsBasePath = `${baseUrl}/${GROUP_TYPE}/${GROUP_ID}/${PROVIDER_RESOURCE_TYPE}/${providerId}/versions`;
        const latestVersion = versions[versions.length - 1]?.version ?? '';

        const result: Record<string, unknown> = {};
        for (let i = 0; i < versions.length; i++) {
            const v = versions[i];
            const versionPath = `/${GROUP_TYPE}/${GROUP_ID}/${PROVIDER_RESOURCE_TYPE}/${providerId}/versions/${v.version}`;
            const ancestor = i > 0 ? versions[i - 1].version : v.version;

            result[v.version] = {
                versionid: v.version,
                xid: versionPath,
                self: `${versionsBasePath}/${v.version}`,
                epoch: this.entityState.getEpoch(versionPath),
                createdat: this.entityState.getCreatedAt(versionPath),
                modifiedat: this.entityState.getModifiedAt(versionPath),
                providerid: providerId,
                isdefault: v.version === latestVersion,
                ancestor,
                // protocols are directly present in the /versions response — no extra fetch needed
                protocols: v.protocols,
                platforms: v.platforms,
            };
        }
        return result;
    }

    // -----------------------------------------------------------------------
    // Single version (with full platform distribution metadata)
    // -----------------------------------------------------------------------

    async getProviderVersion(
        providerId: string,
        versionId: string,
        baseUrl: string
    ): Promise<Record<string, unknown>> {
        const decoded = decodeProviderId(providerId);
        if (!decoded) throw entityNotFound(
            `/${REGISTRY_METADATA.PROVIDER_RESOURCE_TYPE}/${providerId}/versions/${versionId}`,
            'provider', providerId
        );

        const { namespace, type } = decoded;
        const { GROUP_TYPE, GROUP_ID, PROVIDER_RESOURCE_TYPE } = REGISTRY_METADATA;

        const resp = await this.tfService.fetchProviderVersions(namespace, type);
        const versions = resp.versions ?? [];
        const vSummary = versions.find((v) => v.version === versionId);

        if (!vSummary) {
            throw entityNotFound(
                `/${GROUP_TYPE}/${GROUP_ID}/${PROVIDER_RESOURCE_TYPE}/${providerId}/versions/${versionId}`,
                'version', versionId
            );
        }

        const latestVersion = versions[versions.length - 1]?.version ?? '';
        const versionIndex = versions.findIndex((v) => v.version === versionId);
        const ancestor = versionIndex > 0 ? versions[versionIndex - 1].version : versionId;

        const versionPath = `/${GROUP_TYPE}/${GROUP_ID}/${PROVIDER_RESOURCE_TYPE}/${providerId}/versions/${versionId}`;
        const versionBaseUrl = `${baseUrl}/${GROUP_TYPE}/${GROUP_ID}/${PROVIDER_RESOURCE_TYPE}/${providerId}/versions/${versionId}`;

        // Fetch per-platform download details (includes download_url, shasum, signing_keys)
        const platforms = await this.fetchPlatformDistributions(namespace, type, versionId, vSummary);

        // Extract signing keys from first available platform (they are shared across platforms)
        const signingKeys = this.extractSigningKeys(platforms.raw);

        return {
            versionid: versionId,
            xid: versionPath,
            self: versionBaseUrl,
            epoch: this.entityState.getEpoch(versionPath),
            createdat: this.entityState.getCreatedAt(versionPath),
            modifiedat: this.entityState.getModifiedAt(versionPath),
            providerid: providerId,
            isdefault: versionId === latestVersion,
            ancestor,
            protocols: vSummary.protocols,
            // Platform distributions with full download/checksum metadata
            platforms: platforms.enriched,
            signing_keys: signingKeys,
        };
    }

    // -----------------------------------------------------------------------
    // Internals
    // -----------------------------------------------------------------------

    private async fetchPlatformDistributions(
        namespace: string,
        type: string,
        version: string,
        summary: TFProviderVersionSummary
    ): Promise<{ enriched: ProviderPlatformDistribution[]; raw: TFProviderDownloadResponse[] }> {
        const raw: TFProviderDownloadResponse[] = [];
        const enriched: ProviderPlatformDistribution[] = [];

        await Promise.all(
            summary.platforms.map(async (p) => {
                const dl = await this.tfService.fetchProviderPlatformDownload(
                    namespace, type, version, p.os, p.arch
                );
                if (dl) {
                    raw.push(dl);
                    enriched.push({
                        os: p.os,
                        arch: p.arch,
                        filename: dl.filename,
                        download_url: dl.download_url,
                        shasums_url: dl.shasums_url,
                        shasums_signature_url: dl.shasums_signature_url,
                        shasum: dl.shasum,
                    });
                } else {
                    // Platform listed but download metadata unavailable; include minimal entry
                    enriched.push({
                        os: p.os,
                        arch: p.arch,
                        filename: '',
                        download_url: '',
                        shasums_url: '',
                        shasums_signature_url: '',
                        shasum: '',
                    });
                }
            })
        );

        // Sort deterministically by os then arch
        enriched.sort((a, b) => a.os.localeCompare(b.os) || a.arch.localeCompare(b.arch));

        return { enriched, raw };
    }

    private extractSigningKeys(
        rawDownloads: TFProviderDownloadResponse[]
    ): { gpg_public_keys: TFGPGKey[] } {
        const seen = new Set<string>();
        const keys: TFGPGKey[] = [];
        for (const dl of rawDownloads) {
            for (const k of dl.signing_keys?.gpg_public_keys ?? []) {
                if (!seen.has(k.key_id)) {
                    seen.add(k.key_id);
                    keys.push(k);
                }
            }
        }
        return { gpg_public_keys: keys };
    }
}
