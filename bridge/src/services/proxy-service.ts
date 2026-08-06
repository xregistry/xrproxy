/**
 * Proxy service
 * Handles routing requests to appropriate downstream servers
 */

import { RequestHandler } from 'express';
import { createProxyMiddleware, Options } from 'http-proxy-middleware';
import type { IncomingMessage, ServerResponse } from 'http';
import { pipeline } from 'stream/promises';
import { BASE_URL_HEADER, ENABLE_BODY_URL_REWRITE, getApiBaseUrl } from '../config/constants';
import { DownstreamConfig } from '../types/bridge';

export class ProxyService {
    constructor(private readonly logger: any) { }

    /**
     * Recursively rewrite URLs in response data
     * Replaces downstream server URLs with bridge base URL
     * Note: Skips "xid" fields as they are canonical identifiers
     *
     * Only used by the explicitly gated ENABLE_BODY_URL_REWRITE compatibility
     * fallback (see createProxyMiddleware below). The default streaming path
     * never buffers or parses response bodies.
     */
    private rewriteUrls(data: any, downstreamUrl: string, bridgeBaseUrl: string, currentKey?: string): any {
        if (typeof data === 'string') {
            // Skip rewriting "xid" fields - they are canonical identifiers
            if (currentKey === 'xid') {
                return data;
            }
            // Replace URLs in strings (handles "self", "shortself", and any URL fields)
            if (data.startsWith(downstreamUrl)) {
                return data.replace(downstreamUrl, bridgeBaseUrl);
            }
            return data;
        }

        if (Array.isArray(data)) {
            // Recursively process arrays
            return data.map(item => this.rewriteUrls(item, downstreamUrl, bridgeBaseUrl));
        }

        if (data && typeof data === 'object') {
            // Recursively process objects
            const rewritten: any = {};
            for (const [key, value] of Object.entries(data)) {
                rewritten[key] = this.rewriteUrls(value, downstreamUrl, bridgeBaseUrl, key);
            }
            return rewritten;
        }

        return data;
    }

    /**
     * Rewrite a Link header (RFC 8288, used for pagination) so that any
     * downstream-absolute URL still present is replaced with the bridge's
     * externally-visible base URL. Cheap header-only operation: it never
     * touches the response body and is applied unconditionally (not gated
     * behind ENABLE_BODY_URL_REWRITE) because downstream Link headers are
     * frequently generated independently of the JSON body and may still
     * carry the downstream's own URL even when the body already honors
     * X-Base-Url.
     */
    private rewriteLinkHeader(link: string, downstreamUrl: string, bridgeBaseUrl: string): string {
        if (!link.includes(downstreamUrl)) {
            // Nothing to rewrite - avoid building a RegExp for the common case.
            return link;
        }
        const pattern = new RegExp(downstreamUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
        return link.replace(pattern, bridgeBaseUrl);
    }

    /**
     * Create proxy middleware for a specific group type
     */
    createProxyMiddleware(
        groupType: string,
        backend: DownstreamConfig
    ): RequestHandler[] {
        const targetUrl = backend.url;

        this.logger.info('Creating proxy middleware', { groupType, targetUrl });

        // Middleware to inject base URL header
        const headerMiddleware: RequestHandler = (req, res, next) => {
            try {
                // Get the actual API base URL (including API_PATH_PREFIX) from the incoming request
                const actualBaseUrl = getApiBaseUrl(req);
                req.headers[BASE_URL_HEADER] = actualBaseUrl;
                this.logger.debug('Setting x-base-url header for proxy', {
                    groupType,
                    actualBaseUrl,
                    originalUrl: req.originalUrl,
                    forwardedHost: req.get('x-forwarded-host'),
                    host: req.get('host')
                });
                next();
            } catch (error) {
                this.logger.error('Error in route header middleware', {
                    error: error instanceof Error ? error.message : String(error),
                    groupType
                });
                res.status(500).json({ error: 'Internal server error' });
            }
        };

        // Create proxy middleware with options
        const proxyOptions: Options = {
            target: targetUrl,
            changeOrigin: true,
            selfHandleResponse: true,

            // Rewrite path to ensure it goes to the correct backend endpoint
            // The path may include the API prefix (e.g., /registry), which we need to remove
            pathRewrite: (path, req) => {
                // Remove any API prefix if present, then ensure group type is at the start
                let cleanPath = path;

                // Remove /registry prefix if present
                const apiPrefix = process.env.API_PATH_PREFIX || '';
                if (apiPrefix && (cleanPath === apiPrefix || cleanPath.startsWith(`${apiPrefix}/`))) {
                    cleanPath = cleanPath.substring(apiPrefix.length) || '/';
                }

                // Ensure the path starts with the group type
                if (!cleanPath.startsWith(`/${groupType}`)) {
                    cleanPath = `/${groupType}${cleanPath}`;
                }

                return cleanPath;
            },

            // http-proxy-middleware v3 event handlers
            on: {
                // Intercept the response to add CORS/Link header adjustments,
                // then either stream it straight through (default) or -
                // only when explicitly enabled - buffer/parse/rewrite the
                // JSON body as a compatibility fallback.
                proxyRes: (proxyRes: IncomingMessage, req, res: ServerResponse) => {
                // Get the actual base URL from the request that was set by headerMiddleware
                const actualBaseUrl = req.headers[BASE_URL_HEADER] as string;

                // Add CORS headers
                if (!proxyRes.headers['access-control-allow-origin']) {
                    proxyRes.headers['access-control-allow-origin'] = '*';
                }
                if (!proxyRes.headers['access-control-allow-methods']) {
                    proxyRes.headers['access-control-allow-methods'] = 'GET, POST, PUT, DELETE, OPTIONS, PATCH';
                }
                if (!proxyRes.headers['access-control-allow-headers']) {
                    proxyRes.headers['access-control-allow-headers'] =
                        'Origin, X-Requested-With, Content-Type, Accept, Authorization, X-MS-Client-Principal, X-Base-Url, X-Correlation-Id, X-Trace-Id';
                }
                if (!proxyRes.headers['access-control-expose-headers']) {
                    proxyRes.headers['access-control-expose-headers'] =
                        'X-Correlation-Id, X-Trace-Id, X-Request-Id, Location, Link, ETag, Cache-Control, Content-Length, Content-Type, Date, Expires, Last-Modified, X-Registry-Id, X-Registry-Version, X-Registry-Epoch, X-Registry-Self, X-Total-Count';
                }

                // Rewrite the Link header (pagination) in place if a
                // downstream-absolute URL remains. Cheap, header-only,
                // applied regardless of content type or the body-rewrite
                // gate below.
                if (proxyRes.headers['link']) {
                    const originalLink = proxyRes.headers['link'] as string;
                    const rewrittenLink = this.rewriteLinkHeader(originalLink, targetUrl, actualBaseUrl);
                    if (rewrittenLink !== originalLink) {
                        proxyRes.headers['link'] = rewrittenLink;
                        this.logger.debug('Rewrote Link header', {
                            groupType,
                            original: originalLink,
                            rewritten: rewrittenLink
                        });
                    }
                }

                const contentType = (proxyRes.headers['content-type'] as string) || '';
                const isJson = contentType.includes('application/json');

                if (!isJson || !ENABLE_BODY_URL_REWRITE) {
                    // Default fast path: downstream services already receive
                    // X-Base-Url (see headerMiddleware above) and are expected
                    // to emit bridge-correct URLs themselves, so there is no
                    // need to buffer, parse, and re-serialize the body here.
                    // Status and headers are preserved as-is; the response is
                    // streamed through with proper back-pressure and cleanup
                    // via stream/promises pipeline.
                    res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
                    pipeline(proxyRes, res).catch((error) => {
                        this.logger.error('Error streaming proxy response', {
                            error: error instanceof Error ? error.message : String(error),
                            groupType,
                            targetUrl
                        });
                        if (!res.headersSent) {
                            (res as any).status?.(502).json?.({ error: 'Bad Gateway' });
                        } else if (!res.destroyed) {
                            res.destroy();
                        }
                    });
                    return;
                }

                // Compatibility fallback - explicitly gated via
                // ENABLE_BODY_URL_REWRITE=true. Some downstreams may not yet
                // honor X-Base-Url and continue to emit their own
                // (downstream-absolute) URLs inside JSON bodies; buffer,
                // rewrite, and re-serialize only in that case.
                let body = '';
                proxyRes.setEncoding('utf8');
                proxyRes.on('data', (chunk) => {
                    body += chunk;
                });

                proxyRes.on('end', () => {
                    try {
                        // Parse JSON and rewrite URLs using the actual base URL from the request
                        const data = JSON.parse(body);
                        const rewrittenData = this.rewriteUrls(data, targetUrl, actualBaseUrl);

                        // Send rewritten response
                        const rewrittenBody = JSON.stringify(rewrittenData);
                        res.writeHead(proxyRes.statusCode || 200, {
                            ...proxyRes.headers,
                            'content-length': Buffer.byteLength(rewrittenBody).toString()
                        });
                        res.end(rewrittenBody);
                    } catch (error) {
                        this.logger.error('Error rewriting response URLs', {
                            error: error instanceof Error ? error.message : String(error),
                            groupType,
                            targetUrl
                        });
                        // If rewriting fails, send original response
                        res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
                        res.end(body);
                    }
                });

                proxyRes.on('error', (error) => {
                    this.logger.error('Error reading proxy response', {
                        error: error.message,
                        groupType,
                        targetUrl
                    });
                    if (!res.headersSent) {
                        (res as any).status(500).json({ error: 'Error reading upstream response' });
                    }
                });
                },

                // Inject API key and tracing headers
                proxyReq: (proxyReq, req: any) => {
                try {
                    // Forward x-base-url header to downstream service
                    const baseUrlValue = req.headers[BASE_URL_HEADER];
                    if (baseUrlValue) {
                        proxyReq.setHeader(BASE_URL_HEADER, baseUrlValue);
                        this.logger.debug('Forwarding x-base-url header to downstream service', {
                            groupType,
                            baseUrlValue,
                            targetUrl
                        });
                    } else {
                        this.logger.warn('No x-base-url value present on request headers', {
                            groupType,
                            targetUrl
                        });
                    }

                    // Never log the API key itself - only whether one is configured.
                    if (backend.apiKey) {
                        proxyReq.setHeader('Authorization', `Bearer ${backend.apiKey}`);
                    }

                    // Inject distributed tracing headers
                    if (req.logger && req.logger.createDownstreamHeaders) {
                        const traceHeaders = req.logger.createDownstreamHeaders(req);
                        Object.entries(traceHeaders).forEach(([key, value]) => {
                            proxyReq.setHeader(key, String(value));
                        });

                        this.logger.debug('Injected trace headers into proxy request', {
                            groupType,
                            targetUrl,
                            traceId: req.traceId,
                            correlationId: req.correlationId,
                            requestId: req.requestId,
                            injectedHeaders: Object.keys(traceHeaders)
                        });
                    }
                } catch (error) {
                    this.logger.error('Error in proxy request handler', {
                        error: error instanceof Error ? error.message : String(error),
                        groupType,
                        targetUrl
                    });
                }
                },

                // Handle proxy errors
                error: (err, req: any, res) => {
                this.logger.error('Proxy error', {
                    groupType,
                    targetUrl,
                    error: err instanceof Error ? err.message : String(err),
                    traceId: req.traceId,
                    correlationId: req.correlationId,
                    requestId: req.requestId
                });

                // Check if res is ServerResponse (not Socket)
                if ('headersSent' in res && !res.headersSent) {
                    (res as any).status(502).json({
                        error: 'Bad Gateway',
                        message: `Upstream server ${targetUrl} is not available`,
                        groupType,
                        traceId: req.traceId,
                        correlationId: req.correlationId
                    });
                }
                }
            }
        };

        const proxy = createProxyMiddleware(proxyOptions);

        return [headerMiddleware, proxy];
    }
}