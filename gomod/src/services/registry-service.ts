/**
 * Registry Service — xRegistry root, model, capabilities, and group endpoints.
 */

import { EntityStateManager } from '../../../shared/entity-state-manager';
import { MODEL_STRUCTURE, REGISTRY_METADATA } from '../config/constants';
import { CheckpointService } from './checkpoint-service';

const {
    REGISTRY_ID,
    GROUP_TYPE,
    GROUP_TYPE_SINGULAR,
    GROUP_ID,
    RESOURCE_TYPE,
    SPEC_VERSION,
} = REGISTRY_METADATA;

export class RegistryService {
    constructor(
        private readonly checkpoint: CheckpointService,
        private readonly entityState: EntityStateManager
    ) {}

    getCapabilities(): object {
        return {
            apis: ['/capabilities', '/model', '/export'],
            flags: ['doc', 'epoch', 'filter', 'inline', 'sort', 'specversion'],
            formats: ['xRegistry-json/1.0-rc2'],
            mutable: [],
            pagination: true,
            specversions: ['1.0-rc2'],
        };
    }

    getRoot(baseUrl: string): object {
        return {
            specversion: SPEC_VERSION,
            registryid: REGISTRY_ID,
            xid: '/',
            self: `${baseUrl}/`,
            description:
                'xRegistry proxy for the Go Module ecosystem. Exact lookup via GOPROXY; discovery via the append-only Go index.',
            documentation: 'https://pkg.go.dev/',
            capabilities: this.getCapabilities(),
            model: `${baseUrl}/model`,
            [`${GROUP_TYPE}url`]: `${baseUrl}/${GROUP_TYPE}`,
            [`${GROUP_TYPE}count`]: 1,
            epoch: this.entityState.getEpoch('/'),
            createdat: this.entityState.getCreatedAt('/'),
            modifiedat: this.entityState.getModifiedAt('/'),
        };
    }

    getModel(baseUrl: string): object {
        return {
            ...JSON.parse(JSON.stringify(MODEL_STRUCTURE)),
            self: `${baseUrl}/model`,
        };
    }

    getGroups(baseUrl: string): object {
        const groupPath = `/${GROUP_TYPE}/${GROUP_ID}`;
        return {
            [GROUP_ID]: {
                [`${GROUP_TYPE_SINGULAR}id`]: GROUP_ID,
                xid: groupPath,
                self: `${baseUrl}${groupPath}`,
                epoch: this.entityState.getEpoch(groupPath),
                createdat: this.entityState.getCreatedAt(groupPath),
                modifiedat: this.entityState.getModifiedAt(groupPath),
                name: 'Go Module Proxy (proxy.golang.org)',
                [`${RESOURCE_TYPE}url`]: `${baseUrl}${groupPath}/${RESOURCE_TYPE}`,
                // Partial count from catalog — never fabricated; omit when unknown
                [`${RESOURCE_TYPE}count`]: this.checkpoint.getModuleCount() || undefined,
            },
        };
    }

    getGroup(baseUrl: string): object {
        const groupPath = `/${GROUP_TYPE}/${GROUP_ID}`;
        return {
            [`${GROUP_TYPE_SINGULAR}id`]: GROUP_ID,
            xid: groupPath,
            self: `${baseUrl}${groupPath}`,
            epoch: this.entityState.getEpoch(groupPath),
            createdat: this.entityState.getCreatedAt(groupPath),
            modifiedat: this.entityState.getModifiedAt(groupPath),
            name: 'Go Module Proxy (proxy.golang.org)',
            [`${RESOURCE_TYPE}url`]: `${baseUrl}${groupPath}/${RESOURCE_TYPE}`,
            [`${RESOURCE_TYPE}count`]: this.checkpoint.getModuleCount() || undefined,
        };
    }
}
