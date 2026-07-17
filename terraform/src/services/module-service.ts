/**
 * Module Service — builds xRegistry-compliant resource representations
 * for Terraform modules and their versions.
 */

import { EntityStateManager } from '../../../shared/entity-state-manager';
import {
    decodeModuleId,
    encodeModuleId,
    REGISTRY_METADATA,
} from '../config/constants';
import { entityNotFound } from '../utils/xregistry-errors';
import { TerraformService } from './terraform-service';

export class ModuleService {
    private tfService: TerraformService;
    private entityState: EntityStateManager;

    constructor(tfService: TerraformService, entityState: EntityStateManager) {
        this.tfService = tfService;
        this.entityState = entityState;
    }

    // -----------------------------------------------------------------------
    // Resource (module) level
    // -----------------------------------------------------------------------

    async getModuleMetadata(moduleId: string, baseUrl: string): Promise<Record<string, unknown>> {
        const decoded = decodeModuleId(moduleId);
        if (!decoded) throw entityNotFound(`/${REGISTRY_METADATA.MODULE_RESOURCE_TYPE}/${moduleId}`, 'module', moduleId);

        const { namespace, name, provider } = decoded;
        const { GROUP_TYPE, GROUP_ID, MODULE_RESOURCE_TYPE, MODULE_RESOURCE_TYPE_SINGULAR } = REGISTRY_METADATA;

        const versionsResp = await this.tfService.fetchModuleVersions(namespace, name, provider);
        const moduleEntry = versionsResp.modules?.[0];
        const versions = moduleEntry?.versions?.map((v) => v.version) ?? [];
        const latestVersion = versions[0] ?? '';

        const meta = await this.tfService.fetchModuleSearchEntry(namespace, name, provider);

        const resourcePath = `/${GROUP_TYPE}/${GROUP_ID}/${MODULE_RESOURCE_TYPE}/${moduleId}`;
        const resourceBaseUrl = `${baseUrl}/${GROUP_TYPE}/${GROUP_ID}/${MODULE_RESOURCE_TYPE}/${moduleId}`;

        return {
            [`${MODULE_RESOURCE_TYPE_SINGULAR}id`]: moduleId,
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
            // Module-specific attributes
            namespace,
            name,
            provider,
            source: encodeModuleId(namespace, name, provider).replace(/~/g, '/'),
            description: meta?.description ?? '',
            downloads: meta?.downloads ?? 0,
            verified: meta?.verified ?? false,
            trusted: meta?.trusted ?? false,
            owner: meta?.owner ?? '',
        };
    }

    async getModuleMeta(moduleId: string, baseUrl: string): Promise<Record<string, unknown>> {
        const decoded = decodeModuleId(moduleId);
        if (!decoded) throw entityNotFound(`/${REGISTRY_METADATA.MODULE_RESOURCE_TYPE}/${moduleId}/meta`, 'module', moduleId);

        const { namespace, name, provider } = decoded;
        const { GROUP_TYPE, GROUP_ID, MODULE_RESOURCE_TYPE, MODULE_RESOURCE_TYPE_SINGULAR } = REGISTRY_METADATA;

        const versionsResp = await this.tfService.fetchModuleVersions(namespace, name, provider);
        const latestVersion = versionsResp.modules?.[0]?.versions?.[0]?.version ?? '';

        const metaPath = `/${GROUP_TYPE}/${GROUP_ID}/${MODULE_RESOURCE_TYPE}/${moduleId}/meta`;
        const resourceBaseUrl = `${baseUrl}/${GROUP_TYPE}/${GROUP_ID}/${MODULE_RESOURCE_TYPE}/${moduleId}`;

        return {
            [`${MODULE_RESOURCE_TYPE_SINGULAR}id`]: moduleId,
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

    async getModuleVersions(moduleId: string, baseUrl: string): Promise<Record<string, unknown>> {
        const decoded = decodeModuleId(moduleId);
        if (!decoded) throw entityNotFound(`/${REGISTRY_METADATA.MODULE_RESOURCE_TYPE}/${moduleId}/versions`, 'module', moduleId);

        const { namespace, name, provider } = decoded;
        const { GROUP_TYPE, GROUP_ID, MODULE_RESOURCE_TYPE } = REGISTRY_METADATA;

        const resp = await this.tfService.fetchModuleVersions(namespace, name, provider);
        const versions = resp.modules?.[0]?.versions?.map((v) => v.version) ?? [];

        const versionsBaseUrl = `${baseUrl}/${GROUP_TYPE}/${GROUP_ID}/${MODULE_RESOURCE_TYPE}/${moduleId}/versions`;
        const latestVersion = versions[0] ?? '';

        const result: Record<string, unknown> = {};
        for (let i = 0; i < versions.length; i++) {
            const v = versions[i];
            const versionPath = `/${GROUP_TYPE}/${GROUP_ID}/${MODULE_RESOURCE_TYPE}/${moduleId}/versions/${v}`;
            // Terraform module versions are returned newest-first (descending).
            // The ancestor of a version is the next-older entry: versions[i+1],
            // or the version itself if it is the oldest in the list.
            const ancestor = i < versions.length - 1 ? versions[i + 1] : v;

            result[v] = {
                versionid: v,
                xid: versionPath,
                self: `${versionsBaseUrl}/${v}`,
                epoch: this.entityState.getEpoch(versionPath),
                createdat: this.entityState.getCreatedAt(versionPath),
                modifiedat: this.entityState.getModifiedAt(versionPath),
                moduleid: moduleId,
                isdefault: v === latestVersion,
                ancestor,
            };
        }
        return result;
    }

    // -----------------------------------------------------------------------
    // Single version
    // -----------------------------------------------------------------------

    async getModuleVersion(
        moduleId: string,
        versionId: string,
        baseUrl: string
    ): Promise<Record<string, unknown>> {
        const decoded = decodeModuleId(moduleId);
        if (!decoded) throw entityNotFound(
            `/${REGISTRY_METADATA.MODULE_RESOURCE_TYPE}/${moduleId}/versions/${versionId}`,
            'module', moduleId
        );

        const { namespace, name, provider } = decoded;
        const { GROUP_TYPE, GROUP_ID, MODULE_RESOURCE_TYPE } = REGISTRY_METADATA;

        const resp = await this.tfService.fetchModuleVersions(namespace, name, provider);
        const versions = resp.modules?.[0]?.versions?.map((v) => v.version) ?? [];

        if (!versions.includes(versionId)) {
            throw entityNotFound(
                `/${GROUP_TYPE}/${GROUP_ID}/${MODULE_RESOURCE_TYPE}/${moduleId}/versions/${versionId}`,
                'version', versionId
            );
        }

        let detail: Record<string, unknown> = {};
        try {
            const raw = await this.tfService.fetchModuleVersion(namespace, name, provider, versionId);
            detail = {
                source: raw.source,
                owner: raw.owner,
                description: raw.description,
                downloads: raw.downloads,
                verified: raw.verified,
                published_at: raw.published_at,
            };
        } catch { /* best-effort; version still exists */ }

        const latestVersion = versions[0] ?? '';
        const versionIndex = versions.indexOf(versionId);
        // Descending list: ancestor is next-older = versions[versionIndex+1], or self if oldest
        const ancestor = versionIndex < versions.length - 1 ? versions[versionIndex + 1] : versionId;

        const versionPath = `/${GROUP_TYPE}/${GROUP_ID}/${MODULE_RESOURCE_TYPE}/${moduleId}/versions/${versionId}`;
        const versionBaseUrl = `${baseUrl}/${GROUP_TYPE}/${GROUP_ID}/${MODULE_RESOURCE_TYPE}/${moduleId}/versions/${versionId}`;

        return {
            versionid: versionId,
            xid: versionPath,
            self: versionBaseUrl,
            epoch: this.entityState.getEpoch(versionPath),
            createdat: this.entityState.getCreatedAt(versionPath),
            modifiedat: this.entityState.getModifiedAt(versionPath),
            moduleid: moduleId,
            isdefault: versionId === latestVersion,
            ancestor,
            ...detail,
        };
    }
}
