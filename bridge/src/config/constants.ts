/**
 * Bridge configuration constants and environment variables
 */

import { Request } from 'express';

// Server configuration
export const PORT = parseInt(process.env['PORT'] || '8080');
export const BASE_URL = process.env['BASE_URL'] || `http://localhost:${PORT}`;
export const BASE_URL_HEADER = process.env['BASE_URL_HEADER'] || 'x-base-url';

/**
 * Get the actual base URL from the request (protocol + host only)
 * This handles cases where the deployed FQDN differs from the configured BASE_URL
 */
export function getBaseUrl(req: Request): string {
    // Check for custom header first
    const headerValue = req.get(BASE_URL_HEADER);
    if (headerValue) {
        return headerValue;
    }

    // Construct from request
    const protocol = req.get('x-forwarded-proto') || req.protocol || 'https';
    const host = req.get('x-forwarded-host') || req.get('host');

    if (host) {
        return `${protocol}://${host}`;
    }

    // Fallback to configured BASE_URL
    return BASE_URL;
}

/**
 * Get the full API base URL including the API path prefix
 * This is used for generating URLs in xRegistry responses
 */
export function getApiBaseUrl(req: Request): string {
    const baseUrl = getBaseUrl(req);
    
    // Add API_PATH_PREFIX if configured
    if (API_PATH_PREFIX) {
        // Ensure no double slashes
        const prefix = API_PATH_PREFIX.startsWith('/') ? API_PATH_PREFIX : `/${API_PATH_PREFIX}`;
        return `${baseUrl}${prefix}`;
    }
    
    return baseUrl;
}

// Authentication configuration
export const BRIDGE_API_KEY = process.env['BRIDGE_API_KEY'] || '';
export const REQUIRED_GROUPS = process.env['REQUIRED_GROUPS']?.split(',') || [];

// Resilient startup configuration
export const STARTUP_WAIT_TIME = parseInt(process.env['STARTUP_WAIT_TIME'] || '60000'); // 60 seconds
export const RETRY_INTERVAL = parseInt(process.env['RETRY_INTERVAL'] || '60000'); // 60 seconds
export const SERVER_HEALTH_TIMEOUT = parseInt(process.env['SERVER_HEALTH_TIMEOUT'] || '10000'); // 10 seconds
export const ROOT_METADATA_TIMEOUT = parseInt(process.env['ROOT_METADATA_TIMEOUT'] || '2000'); // 2 seconds

// Response body rewriting
//
// Downstream services already receive the X-Base-Url header (see
// ProxyService) and are expected to emit bridge-correct absolute URLs
// themselves. The default, fast path therefore streams proxied responses
// through unmodified (status + headers preserved, no buffering, no JSON
// parse/re-serialize). Set ENABLE_BODY_URL_REWRITE=true only as an explicit
// compatibility fallback for downstreams that do not yet honor the header
// and still emit their own (downstream-absolute) URLs in JSON bodies.
export const ENABLE_BODY_URL_REWRITE = (process.env['ENABLE_BODY_URL_REWRITE'] || '').toLowerCase() === 'true';

// Health/readiness caching
//
// /health and /ready must be constant-time and safe for Kubernetes
// liveness/readiness probes: they report the cached downstream state
// maintained by the background retry loop, never performing a live
// network fan-out to downstreams on the request path. Active,
// on-demand probing is still available (see HealthService.getDetailedHealth)
// but is bounded by SERVER_HEALTH_TIMEOUT per downstream and memoized for
// HEALTH_PROBE_CACHE_TTL milliseconds so repeated diagnostic calls cannot
// turn into a downstream DoS amplifier.
export const HEALTH_PROBE_CACHE_TTL = parseInt(process.env['HEALTH_PROBE_CACHE_TTL'] || '5000'); // 5 seconds

// Downstream configuration
export const CONFIG_FILE = process.env['BRIDGE_CONFIG_FILE'] || 'downstreams.json';
export const DOWNSTREAMS_JSON = process.env['DOWNSTREAMS_JSON'];

// Logging configuration
export const SERVICE_NAME = process.env['SERVICE_NAME'] || 'xregistry-bridge';
export const SERVICE_VERSION = process.env['SERVICE_VERSION'] || '1.0.0';
export const LOG_LEVEL = process.env['LOG_LEVEL'] || 'info';
export const NODE_ENV = process.env['NODE_ENV'] || 'production';

// Viewer configuration
// Note: Debug logging for these moved to server.ts where logger is available
export const VIEWER_ENABLED = (process.env['VIEWER_ENABLED'] || '').toLowerCase() === 'true';
export const VIEWER_PATH = process.env['VIEWER_PATH'] || undefined;
export const VIEWER_PROXY_ENABLED = (process.env['VIEWER_PROXY_ENABLED'] || 'true').toLowerCase() !== 'false'; // Default true if not explicitly disabled
export const API_PATH_PREFIX = process.env['API_PATH_PREFIX'] || ''; // Empty means root, '/registry' shifts API

// Bridge metadata
export const BRIDGE_STARTUP_TIME = new Date().toISOString();
export let BRIDGE_EPOCH = 1;

export function incrementBridgeEpoch(): void {
    BRIDGE_EPOCH++;
}
