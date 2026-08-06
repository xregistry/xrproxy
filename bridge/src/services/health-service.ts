/**
 * Health monitoring service
 * Provides health check and status information
 */

import { HEALTH_PROBE_CACHE_TTL, RETRY_INTERVAL, SERVER_HEALTH_TIMEOUT } from '../config/constants';
import { BridgeHealth, BridgeStatus, DownstreamHealth, ServerStatus } from '../types/bridge';
import { DownstreamService } from './downstream-service';
import { ModelService } from './model-service';

export class HealthService {
    // Memoizes the result of the last active downstream probe (see
    // getDetailedHealth). Keeps diagnostic, on-demand probing from turning
    // into a downstream DoS amplifier if called repeatedly/concurrently.
    private detailedHealthCache: { result: BridgeHealth; expiresAt: number } | null = null;
    private detailedHealthInFlight: Promise<BridgeHealth> | null = null;

    constructor(
        private readonly downstreamService: DownstreamService,
        private readonly modelService: ModelService,
        private readonly logger: any
    ) { }

    /**
     * Get comprehensive health status.
     *
     * This is the fast path used by /health, /ready, and Kubernetes
     * liveness/readiness probes. It is constant-time with respect to
     * request volume: it only reads the in-memory downstream state that
     * the background initialization/retry loop already maintains, and
     * never performs a live network call to any downstream. This keeps
     * probe latency bounded and independent of downstream availability,
     * which matters because Kubernetes will consider the pod unhealthy
     * (and may restart it) if a liveness probe stalls or times out.
     *
     * For an on-demand active probe, see getDetailedHealth().
     */
    async getHealth(): Promise<BridgeHealth> {
        const serverStates = this.downstreamService.getServerStates();
        const groupTypeToBackend = this.modelService.getGroupTypeToBackend();

        const serverHealth: DownstreamHealth[] = Array.from(serverStates.values()).map((state) => ({
            url: state.server.url,
            // Cached state only - "healthy" mirrors the last known
            // activation state from the background retry loop, not a
            // synchronous probe performed on this request.
            healthy: state.isActive,
            active: state.isActive,
            lastAttempt: new Date(state.lastAttempt).toISOString(),
            error: state.error,
            groups: Object.keys(groupTypeToBackend).filter(groupType =>
                groupTypeToBackend[groupType].url === state.server.url
            )
        }));

        const healthyServers = serverHealth.filter((state) => state.healthy).length;
        const groupCollisions = this.modelService.getGroupCollisions();
        const status = healthyServers === 0
            ? 'unhealthy'
            : groupCollisions.length > 0
                ? 'degraded'
                : 'healthy';

        return {
            status,
            timestamp: new Date().toISOString(),
            activeServers: healthyServers,
            totalServers: serverStates.size,
            downstreams: serverHealth,
            consolidatedGroups: Object.keys(groupTypeToBackend),
            groupCollisions,
            retryInterval: RETRY_INTERVAL
        };
    }

    /**
     * Get comprehensive health status backed by a *live* probe of every
     * downstream, for diagnostic/operator use only - never wire this into
     * a Kubernetes liveness/readiness probe or any other constant-time
     * path.
     *
     * Bounded in two ways so it can't be abused as a downstream DoS
     * amplifier:
     *   - each downstream probe carries its own strict timeout
     *     (SERVER_HEALTH_TIMEOUT, enforced inside
     *     DownstreamService.checkServerHealth);
     *   - the aggregate result is memoized for HEALTH_PROBE_CACHE_TTL
     *     milliseconds, and concurrent callers within that window share a
     *     single in-flight probe rather than each triggering their own
     *     fan-out.
     */
    async getDetailedHealth(): Promise<BridgeHealth> {
        const now = Date.now();
        if (this.detailedHealthCache && this.detailedHealthCache.expiresAt > now) {
            return this.detailedHealthCache.result;
        }
        if (this.detailedHealthInFlight) {
            return this.detailedHealthInFlight;
        }

        const probe = this.probeHealth()
            .then((result) => {
                this.detailedHealthCache = { result, expiresAt: Date.now() + HEALTH_PROBE_CACHE_TTL };
                return result;
            })
            .finally(() => {
                this.detailedHealthInFlight = null;
            });

        this.detailedHealthInFlight = probe;
        return probe;
    }

    private async probeHealth(): Promise<BridgeHealth> {
        const serverStates = this.downstreamService.getServerStates();
        const groupTypeToBackend = this.modelService.getGroupTypeToBackend();

        const healthChecks = Array.from(serverStates.values()).map(async (state) => {
            // Defense-in-depth: DownstreamService.checkServerHealth already
            // enforces SERVER_HEALTH_TIMEOUT via its axios request timeout,
            // but this bridge-side race guarantees the diagnostic endpoint
            // itself is bounded even if that inner timeout were ever
            // bypassed (e.g. DNS resolution stalls that ignore the axios
            // timeout option). A stalled/failed probe is treated as
            // unhealthy rather than propagating an error.
            const isCurrentlyHealthy = await this.withStrictTimeout(
                this.downstreamService.checkServerHealth(state.server),
                SERVER_HEALTH_TIMEOUT
            ).catch(() => false);

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
        const healthyServers = serverHealth.filter((state) => state.healthy).length;
        const groupCollisions = this.modelService.getGroupCollisions();
        const status = healthyServers === 0
            ? 'unhealthy'
            : groupCollisions.length > 0
                ? 'degraded'
                : 'healthy';

        return {
            status,
            timestamp: new Date().toISOString(),
            activeServers: healthyServers,
            totalServers: serverStates.size,
            downstreams: serverHealth,
            consolidatedGroups: Object.keys(groupTypeToBackend),
            groupCollisions,
            retryInterval: RETRY_INTERVAL
        };
    }

    /**
     * Race a promise against a hard timeout. Always clears the timer so no
     * dangling handle keeps the event loop alive or leaks across calls.
     */
    private withStrictTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error(`Health probe exceeded ${timeoutMs}ms timeout`));
            }, timeoutMs);

            promise
                .then((value) => {
                    clearTimeout(timer);
                    resolve(value);
                })
                .catch((error) => {
                    clearTimeout(timer);
                    reject(error);
                });
        });
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