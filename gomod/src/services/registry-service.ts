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
            [`${GROUP_TYPE}count`]: this.checkpoint.getGroupCount(),
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

    getGroups(baseUrl: string, offset: number, limit: number): {
        groups: Record<string, unknown>;
        totalCount: number;
    } {
        const { groupIds, totalKnown } = this.checkpoint.listGroupIds(offset, limit);
        const groups: Record<string, unknown> = {};
        for (const groupId of groupIds) {
            const groupPath = `/${GROUP_TYPE}/${groupId}`;
            groups[groupId] = {
                [`${GROUP_TYPE_SINGULAR}id`]: groupId,
                xid: groupPath,
                self: `${baseUrl}${groupPath}`,
                epoch: this.entityState.getEpoch(groupPath),
                createdat: this.entityState.getCreatedAt(groupPath),
                modifiedat: this.entityState.getModifiedAt(groupPath),
                name: groupId,
                [`${RESOURCE_TYPE}url`]: `${baseUrl}${groupPath}/${RESOURCE_TYPE}`,
                [`${RESOURCE_TYPE}count`]: this.checkpoint.getGroupModuleCount(groupId),
            };
        }
        return { groups, totalCount: totalKnown };
    }

    getGroup(baseUrl: string, groupId: string): object {
        const groupPath = `/${GROUP_TYPE}/${groupId}`;
        const moduleCount = this.checkpoint.getGroupModuleCount(groupId);
        return {
            [`${GROUP_TYPE_SINGULAR}id`]: groupId,
            xid: groupPath,
            self: `${baseUrl}${groupPath}`,
            epoch: this.entityState.getEpoch(groupPath),
            createdat: this.entityState.getCreatedAt(groupPath),
            modifiedat: this.entityState.getModifiedAt(groupPath),
            name: groupId,
            [`${RESOURCE_TYPE}url`]: `${baseUrl}${groupPath}/${RESOURCE_TYPE}`,
            [`${RESOURCE_TYPE}count`]: moduleCount || undefined,
        };
    }
}
