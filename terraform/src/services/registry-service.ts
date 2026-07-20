/** xRegistry root and Terraform namespace group entities. */

import { EntityStateManager } from '../../../shared/entity-state-manager';
import { CAPABILITIES, REGISTRY_METADATA } from '../config/constants';
import { SearchService, TerraformNamespaceSummary } from './search-service';

export class RegistryService {
    constructor(
        private readonly searchService: SearchService,
        private readonly entityState: EntityStateManager
    ) {}

    getCapabilities(): typeof CAPABILITIES {
        return CAPABILITIES;
    }

    getRoot(baseUrl: string): Record<string, unknown> {
        const { REGISTRY_ID, GROUP_TYPE, SPEC_VERSION, REGISTRY_HOST } = REGISTRY_METADATA;
        return {
            specversion: SPEC_VERSION,
            registryid: REGISTRY_ID,
            xid: '/',
            self: `${baseUrl}/`,
            description: `xRegistry proxy for Terraform providers and modules on ${REGISTRY_HOST}, grouped by namespace.`,
            documentation: `${baseUrl}/model`,
            capabilities: this.getCapabilities(),
            [`${GROUP_TYPE}url`]: `${baseUrl}/${GROUP_TYPE}`,
            epoch: this.entityState.getEpoch('/'),
            createdat: this.entityState.getCreatedAt('/'),
            modifiedat: this.entityState.getModifiedAt('/'),
        };
    }

    getNamespaces(): TerraformNamespaceSummary[] {
        return this.searchService.getNamespaces();
    }

    async resolveNamespace(namespace: string): Promise<TerraformNamespaceSummary | null> {
        return this.searchService.resolveNamespace(namespace);
    }

    getGroup(baseUrl: string, summary: TerraformNamespaceSummary): Record<string, unknown> {
        const {
            GROUP_TYPE, GROUP_TYPE_SINGULAR, PROVIDER_RESOURCE_TYPE,
            MODULE_RESOURCE_TYPE, REGISTRY_HOST,
        } = REGISTRY_METADATA;
        const groupPath = `/${GROUP_TYPE}/${summary.namespace}`;
        const self = `${baseUrl}/${GROUP_TYPE}/${encodeURIComponent(summary.namespace)}`;
        return {
            [`${GROUP_TYPE_SINGULAR}id`]: summary.namespace,
            xid: groupPath,
            name: summary.namespace,
            namespace: summary.namespace,
            registryhost: REGISTRY_HOST,
            description: `Terraform namespace ${summary.namespace} on ${REGISTRY_HOST}.`,
            epoch: this.entityState.getEpoch(groupPath),
            createdat: this.entityState.getCreatedAt(groupPath),
            modifiedat: this.entityState.getModifiedAt(groupPath),
            self,
            [`${PROVIDER_RESOURCE_TYPE}url`]: `${self}/${PROVIDER_RESOURCE_TYPE}`,
            [`${MODULE_RESOURCE_TYPE}url`]: `${self}/${MODULE_RESOURCE_TYPE}`,
        };
    }
}
