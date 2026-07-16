/**
 * Health monitoring service
 * Provides health check and status information
 */

import { RETRY_INTERVAL } from '../config/constants';
import { BridgeHealth, BridgeStatus, DownstreamHealth, ServerStatus } from '../types/bridge';
import { DownstreamService } from './downstream-service';
import { ModelService } from './model-service';

export class HealthService {
    constructor(
        private readonly downstreamService: DownstreamService,
        private readonly modelService: ModelService,
        private readonly logger: any
    ) { }

    /**
     * Get comprehensive health status
     */
    async getHealth(): Promise<BridgeHealth> {
        const serverStates = this.downstreamService.getServerStates();
        const groupTypeToBackend = this.modelService.getGroupTypeToBackend();

        const healthChecks = Array.from(serverStates.values()).map(async (state) => {
            const isCurrentlyHealthy = await this.downstreamService.checkServerHealth(state.server);

            return {
                url: state.server.url,
                healthy: isCurrentlyHealthy,
                active: state.isActive,
                lastAttempt: new Date(state.lastAttempt).toISOString(),
                error: state.error,
                groups: Object.keys(groupTypeToBackend).filter(groupType =>
                    groupTypeToBackend[groupType].url === state.server.url
                )
            } as DownstreamHealth;
        });

        const serverHealth = await Promise.all(healthChecks);
        const hasActiveServers = this.downstreamService.getActiveServers().length > 0;
        const groupCollisions = this.modelService.getGroupCollisions();
        const status = !hasActiveServers
            ? 'unhealthy'
            : groupCollisions.length > 0
                ? 'degraded'
                : 'healthy';

        return {
            status,
            timestamp: new Date().toISOString(),
            activeServers: this.downstreamService.getActiveServers().length,
            totalServers: serverStates.size,
            downstreams: serverHealth,
            consolidatedGroups: Object.keys(groupTypeToBackend),
            groupCollisions,
            retryInterval: RETRY_INTERVAL
        };
    }

    /**
     * Get detailed status information
     */
    getStatus(): BridgeStatus {
        const serverStates = this.downstreamService.getServerStates();
        const groupTypeToBackend = this.modelService.getGroupTypeToBackend();
        const consolidatedModel = this.modelService.getConsolidatedModel();

        const serverStatus: ServerStatus[] = Array.from(serverStates.values()).map(state => ({
            url: state.server.url,
            active: state.isActive,
            lastAttempt: new Date(state.lastAttempt).toISOString(),
            error: state.error,
            hasModel: !!state.model,
            groups: state.model?.groups ? Object.keys(state.model.groups) : []
        }));

        return {
            timestamp: new Date().toISOString(),
            servers: serverStatus,
            consolidatedModel,
            groupMappings: Object.keys(groupTypeToBackend).reduce((acc, groupType) => {
                acc[groupType] = groupTypeToBackend[groupType].url;
                return acc;
            }, {} as Record<string, string>),
            groupCollisions: this.modelService.getGroupCollisions(),
            configuration: {
                startupWaitTime: parseInt(process.env['STARTUP_WAIT_TIME'] || '60000'),
                retryInterval: RETRY_INTERVAL,
                serverHealthTimeout: parseInt(process.env['SERVER_HEALTH_TIMEOUT'] || '10000')
            }
        };
    }
}
