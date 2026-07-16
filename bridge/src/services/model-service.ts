/**
 * Model consolidation service
 * Consolidates models and capabilities from multiple downstream servers
 */

import { incrementBridgeEpoch } from '../config/constants';
import {
    ConsolidatedCapabilities,
    ConsolidatedModel,
    DownstreamConfig,
    GroupCollision,
    ServerState
} from '../types/bridge';

export class ModelService {
    private consolidatedModel: ConsolidatedModel = {};
    private consolidatedCapabilities: ConsolidatedCapabilities = {};
    private groupTypeToBackend: Record<string, DownstreamConfig> = {};
    private groupCollisions: GroupCollision[] = [];

    constructor(private readonly logger: any) { }

    /**
     * Get the consolidated model
     */
    getConsolidatedModel(): ConsolidatedModel {
        return this.consolidatedModel;
    }

    /**
     * Get the consolidated capabilities.
     *
     * The bridge's externally-visible capabilities are about the bridge's
     * own API, not a union of downstream implementation choices. Return a
     * spec-conformant capabilities object per xRegistry core spec
     * §"Design: JSON Serialization" rather than the historical shallow
     * merge of downstream responses (which inherited the wrong
     * `mutable:bool` and ad-hoc `filter/sort/doc` top-level flags).
     */
    getConsolidatedCapabilities(): ConsolidatedCapabilities {
        return {
            apis: ['/capabilities', '/model', '/export'],
            flags: ['doc', 'epoch', 'filter', 'inline', 'sort', 'specversion'],
            formats: ['xRegistry-json/1.0-rc2'],
            mutable: [],
            pagination: true,
            specversions: ['1.0-rc2']
        } as ConsolidatedCapabilities;
    }

    /**
     * Get group type to backend mapping
     */
    getGroupTypeToBackend(): Record<string, DownstreamConfig> {
        return this.groupTypeToBackend;
    }

    /**
     * Get backend server for a specific group type
     */
    getBackendForGroup(groupType: string): DownstreamConfig | undefined {
        return this.groupTypeToBackend[groupType];
    }

    getGroupCollisions(): GroupCollision[] {
        return this.groupCollisions.map(collision => ({
            groupType: collision.groupType,
            servers: [...collision.servers]
        }));
    }

    /**
     * Rebuild consolidated model from active servers
     */
    rebuildConsolidatedModel(serverStates: Map<string, ServerState>): boolean {
        const previousGroups = Object.keys(this.groupTypeToBackend).sort();
        const previousCollisions = JSON.stringify(this.groupCollisions);

        // Reset consolidated state
        this.consolidatedModel = {};
        this.consolidatedCapabilities = {};
        this.groupTypeToBackend = {};
        this.groupCollisions = [];

        const activeStates = Array.from(serverStates.entries())
            .filter(([, state]) => state.isActive && state.model && state.capabilities)
            .sort(([left], [right]) => left.localeCompare(right));

        const groupCandidates = new Map<string, Array<{ url: string; state: ServerState; definition: any }>>();

        for (const [url, state] of activeStates) {
            const { model, capabilities } = state;

            // Preserve deterministic non-group model metadata. Group definitions
            // are assembled separately so a duplicate can never silently win.
            const { groups: _groups, ...modelMetadata } = model;
            this.consolidatedModel = {
                ...this.consolidatedModel,
                ...modelMetadata
            };
            this.consolidatedCapabilities = {
                ...this.consolidatedCapabilities,
                ...capabilities
            };

            for (const [groupType, definition] of Object.entries(model.groups || {})) {
                const candidates = groupCandidates.get(groupType) || [];
                candidates.push({ url, state, definition });
                groupCandidates.set(groupType, candidates);
            }
        }

        const consolidatedGroups: Record<string, any> = {};
        for (const groupType of Array.from(groupCandidates.keys()).sort()) {
            const candidates = groupCandidates.get(groupType)!;
            if (candidates.length !== 1) {
                const servers = candidates.map(candidate => candidate.url).sort();
                this.groupCollisions.push({ groupType, servers });
                this.logger.error('Group type collision detected; group disabled', {
                    groupType,
                    servers
                });
                continue;
            }

            const candidate = candidates[0];
            consolidatedGroups[groupType] = candidate.definition;
            this.groupTypeToBackend[groupType] = candidate.state.server;
        }
        this.consolidatedModel.groups = consolidatedGroups;

        const currentGroups = Object.keys(this.groupTypeToBackend).sort();
        const hasChanges = previousGroups.length !== currentGroups.length ||
            !previousGroups.every((group, index) => group === currentGroups[index]) ||
            previousCollisions !== JSON.stringify(this.groupCollisions);

        if (hasChanges) {
            this.logger.info('Consolidated model updated', {
                availableGroups: currentGroups,
                collisions: this.groupCollisions,
                activeServers: Array.from(serverStates.values())
                    .filter(s => s.isActive)
                    .map(s => s.server.url)
            });

            // Increment epoch on model changes
            incrementBridgeEpoch();
        }

        return hasChanges;
    }

    /**
     * Get available group types
     */
    getAvailableGroups(): string[] {
        return Object.keys(this.groupTypeToBackend);
    }

    /**
     * Check if a group type is available
     */
    isGroupAvailable(groupType: string): boolean {
        return !!this.groupTypeToBackend[groupType];
    }
}
