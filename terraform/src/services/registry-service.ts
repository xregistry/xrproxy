/**
 * Registry Service — xRegistry root and group endpoints.
 * /model, /capabilities, /health, /ready are handled by @xregistry/registry-core createRegistryApp.
 */

import { EntityStateManager } from '../../../shared/entity-state-manager';
import { REGISTRY_METADATA } from '../config/constants';
import { SearchService } from './search-service';

export class RegistryService {
    private searchService: SearchService;
    private entityState: EntityStateManager;

    constructor(searchService: SearchService, entityState: EntityStateManager) {
        this.searchService = searchService;
        this.entityState = entityState;
    }

    /** Capabilities shape (mirrored in server.ts for createRegistryApp) */
    getCapabilities(): Record<string, unknown> {
        return {
            apis: ['/capabilities', '/model', '/export'],
            filter: true,
            sort: true,
            doc: false,
            mutable: false,
            pagination: true,
        };
    }

    getRoot(baseUrl: string): Record<string, unknown> {
        const { REGISTRY_ID, GROUP_TYPE, SPEC_VERSION } = REGISTRY_METADATA;
        return {
            specversion: SPEC_VERSION,
            registryid: REGISTRY_ID,
            xid: '/',
            self: `${baseUrl}/`,
            description: 'xRegistry proxy for the Terraform Registry (providers and modules).',
            documentation: `${baseUrl}/model`,
            capabilities: this.getCapabilities(),
            model: `${baseUrl}/model`,
            [`${GROUP_TYPE}url`]: `${baseUrl}/${GROUP_TYPE}`,
            [`${GROUP_TYPE}count`]: 1,
            epoch: this.entityState.getEpoch('/'),
            createdat: this.entityState.getCreatedAt('/'),
            modifiedat: this.entityState.getModifiedAt('/'),
        };
    }

    getGroups(baseUrl: string): Record<string, unknown> {
        const { GROUP_TYPE, GROUP_ID, GROUP_TYPE_SINGULAR } = REGISTRY_METADATA;
        const groupPath = `/${GROUP_TYPE}/${GROUP_ID}`;
        return {
            [GROUP_ID]: this.buildGroupObject(baseUrl, GROUP_TYPE, GROUP_ID, GROUP_TYPE_SINGULAR, groupPath, false),
        };
    }

    getGroupDetails(baseUrl: string): Record<string, unknown> {
        const { GROUP_TYPE, GROUP_ID, GROUP_TYPE_SINGULAR } = REGISTRY_METADATA;
        const groupPath = `/${GROUP_TYPE}/${GROUP_ID}`;
        return this.buildGroupObject(baseUrl, GROUP_TYPE, GROUP_ID, GROUP_TYPE_SINGULAR, groupPath, true);
    }

    private buildGroupObject(
        baseUrl: string,
        groupType: string,
        groupId: string,
        groupTypeSingular: string,
        groupPath: string,
        includeCounts: boolean
    ): Record<string, unknown> {
        const { PROVIDER_RESOURCE_TYPE, MODULE_RESOURCE_TYPE } = REGISTRY_METADATA;
        const obj: Record<string, unknown> = {
            [`${groupTypeSingular}id`]: groupId,
            xid: groupPath,
            name: groupId,
            description: 'Terraform Registry — providers and modules',
            epoch: this.entityState.getEpoch(groupPath),
            createdat: this.entityState.getCreatedAt(groupPath),
            modifiedat: this.entityState.getModifiedAt(groupPath),
            self: `${baseUrl}/${groupType}/${groupId}`,
            [`${PROVIDER_RESOURCE_TYPE}url`]: `${baseUrl}/${groupType}/${groupId}/${PROVIDER_RESOURCE_TYPE}`,
            [`${MODULE_RESOURCE_TYPE}url`]: `${baseUrl}/${groupType}/${groupId}/${MODULE_RESOURCE_TYPE}`,
        };
        if (includeCounts) {
            obj[`${PROVIDER_RESOURCE_TYPE}count`] = this.searchService.getProviderCount();
            obj[`${MODULE_RESOURCE_TYPE}count`] = this.searchService.getModuleCount();
        }
        return obj;
    }
}
