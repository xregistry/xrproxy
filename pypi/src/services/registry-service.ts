/**
 * Registry Service - Handles xRegistry root, groups, and model endpoints.
 */

import { EntityStateManager } from '../../../shared/entity-state-manager';
import { MODEL_STRUCTURE, PYPI_API, REGISTRY_METADATA } from '../config/constants';
import { SearchService } from './search-service';

export class RegistryService {
    private searchService: SearchService;
    private readonly entityState: EntityStateManager;

    constructor(searchService: SearchService, entityState: EntityStateManager) {
        this.searchService = searchService;
        this.entityState = entityState;
    }

    getRoot(baseUrl: string): any {
        const { REGISTRY_ID, GROUP_TYPE, SPEC_VERSION } = REGISTRY_METADATA;

        return {
            specversion: SPEC_VERSION,
            registryid: REGISTRY_ID,
            xid: '/',
            self: `${baseUrl}/`,
            description: 'This registry exposes a PyPI projection through xRegistry.',
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

    getCapabilities(): any {
        return {
            apis: ['/capabilities', '/model', '/export'],
            flags: ['doc', 'epoch', 'filter', 'inline', 'sort', 'specversion'],
            formats: ['xRegistry-json/1.0-rc2'],
            mutable: [],
            pagination: true,
            specversions: ['1.0-rc2'],
        };
    }

    getModel(baseUrl: string): any {
        return {
            ...JSON.parse(JSON.stringify(MODEL_STRUCTURE)),
            self: `${baseUrl}/model`,
        };
    }

    getGroups(baseUrl: string): Record<string, any> {
        const { GROUP_TYPE, GROUP_ID, GROUP_TYPE_SINGULAR, RESOURCE_TYPE } = REGISTRY_METADATA;
        const groupPath = `/${GROUP_TYPE}/${GROUP_ID}`;
        const packagesCount = this.searchService.getPackageCount();

        return {
            [GROUP_ID]: {
                [`${GROUP_TYPE_SINGULAR}id`]: GROUP_ID,
                xid: groupPath,
                name: GROUP_ID,
                description: 'Projection of Python package metadata into xRegistry.',
                epoch: this.entityState.getEpoch(groupPath),
                createdat: this.entityState.getCreatedAt(groupPath),
                modifiedat: this.entityState.getModifiedAt(groupPath),
                self: `${baseUrl}/${GROUP_TYPE}/${GROUP_ID}`,
                sourceurl: PYPI_API.SIMPLE_URL,
                [`${RESOURCE_TYPE}url`]: `${baseUrl}/${GROUP_TYPE}/${GROUP_ID}/${RESOURCE_TYPE}`,
                [`${RESOURCE_TYPE}count`]: packagesCount,
            },
        };
    }

    getGroupDetails(baseUrl: string): any {
        const { GROUP_TYPE, GROUP_ID, GROUP_TYPE_SINGULAR, RESOURCE_TYPE } = REGISTRY_METADATA;
        const groupPath = `/${GROUP_TYPE}/${GROUP_ID}`;
        const packagesCount = this.searchService.getPackageCount();

        return {
            [`${GROUP_TYPE_SINGULAR}id`]: GROUP_ID,
            xid: groupPath,
            name: GROUP_ID,
            description: 'Projection of Python package metadata into xRegistry.',
            epoch: this.entityState.getEpoch(groupPath),
            createdat: this.entityState.getCreatedAt(groupPath),
            modifiedat: this.entityState.getModifiedAt(groupPath),
            self: `${baseUrl}/${GROUP_TYPE}/${GROUP_ID}`,
            sourceurl: PYPI_API.SIMPLE_URL,
            [`${RESOURCE_TYPE}url`]: `${baseUrl}/${GROUP_TYPE}/${GROUP_ID}/${RESOURCE_TYPE}`,
            [`${RESOURCE_TYPE}count`]: packagesCount,
        };
    }
}
