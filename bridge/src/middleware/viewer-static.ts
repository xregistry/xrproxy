import express from 'express';
import path from 'path';
import fs from 'fs';
import { XRegistryLogger } from '../../../shared/logging/logger';
import { getApiBaseUrl } from '../config/constants';

/**
 * Tracking-debris query parameters that should be stripped from inbound
 * viewer URLs. Outlook in particular concatenates `&SLSync=Y` directly
 * into the path (producing `/viewer/&SLSync=Y`), breaking SPA routing;
 * various marketing/analytics products do the same with their own keys.
 *
 * The xregistry/viewer submodule has this same logic in its standalone
 * `server.js` (see xregistry/viewer#18). The composite deployment in
 * this repo serves the viewer via the bridge's static middleware
 * instead of the standalone server, so the strip has to live here too.
 */
const TRACKING_QUERY_PARAMS = new Set([
    'slsync',
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
    'fbclid', 'gclid', 'msclkid', 'mc_cid', 'mc_eid', 'igshid', 'oly_anon_id',
    '_hsenc', '_hsmi'
]);

/**
 * Strip `&KEY=VALUE` fragments accidentally concatenated into the URL
 * path and remove known tracking query parameters. Returns the cleaned
 * URL (path + optional query string) or `null` if nothing needed
 * cleaning.
 */
function cleanViewerUrl(req: express.Request): string | null {
    const originalPath = req.path;
    const cleanedPath = originalPath.replace(/&[A-Za-z0-9_.-]+=[^/?#&]*/g, '');

    const cleanedQuery: Record<string, string> = {};
    let queryMutated = false;
    for (const [k, v] of Object.entries(req.query || {})) {
        if (TRACKING_QUERY_PARAMS.has(k.toLowerCase())) {
            queryMutated = true;
            continue;
        }
        if (typeof v === 'string') {
            cleanedQuery[k] = v;
        } else if (Array.isArray(v) && v.every((entry) => typeof entry === 'string')) {
            cleanedQuery[k] = (v as string[]).join(',');
        }
    }

    if (cleanedPath === originalPath && !queryMutated) {
        return null;
    }

    const qs = new URLSearchParams(cleanedQuery).toString();
    return (cleanedPath || '/') + (qs ? `?${qs}` : '');
}

export interface ViewerStaticOptions {
    enabled: boolean;
    viewerPath?: string;
    indexFallback?: boolean;
    logger?: XRegistryLogger;
}

/**
 * Creates middleware for serving xRegistry Viewer static files.
 * 
 * @param options - Configuration options for the viewer static middleware
 * @returns Express middleware or null if disabled
 */
export function createViewerStaticMiddleware(options: ViewerStaticOptions): express.RequestHandler | null {
    const logger = options.logger;
    
    if (logger) {
        logger.info('[VIEWER-DEBUG] createViewerStaticMiddleware called', {
            enabled: options.enabled,
            viewerPath: options.viewerPath,
            indexFallback: options.indexFallback
        });
    }
    
    if (!options.enabled) {
        if (logger) {
            logger.info('[VIEWER-DEBUG] Viewer is DISABLED, returning null');
        }
        return null;
    }

    // Default to viewer submodule dist path (Angular builds to dist/xregistry-viewer by default)
    const viewerPath = options.viewerPath || path.join(__dirname, '../../../viewer/dist/xregistry-viewer');
    
    if (logger) {
        logger.info(`[VIEWER-DEBUG] Checking if viewer path exists`, { viewerPath });
    }
    
    if (!fs.existsSync(viewerPath)) {
        if (logger) {
            logger.warn(`[VIEWER-DEBUG] Viewer path does NOT EXIST. Viewer will not be served.`, { viewerPath });
            logger.warn('Build the viewer first: cd viewer && npm install && npm run build');
        }
        return null;
    }
    
    if (logger) {
        const contents = fs.readdirSync(viewerPath).slice(0, 5);
        logger.info(`[VIEWER-DEBUG] Viewer path EXISTS!`, { viewerPath, fileCount: fs.readdirSync(viewerPath).length, firstFiles: contents });
    }

    // Create static file middleware with proper configuration
    const staticMiddleware = express.static(viewerPath, {
        index: 'index.html',
        setHeaders: (res, filePath) => {
            // Set proper content types
            if (filePath.endsWith('.js')) {
                res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
            } else if (filePath.endsWith('.css')) {
                res.setHeader('Content-Type', 'text/css; charset=utf-8');
            } else if (filePath.endsWith('.json')) {
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
            } else if (filePath.endsWith('.html')) {
                res.setHeader('Content-Type', 'text/html; charset=utf-8');
            }
            
            // Cache static assets but not index.html
            if (filePath.endsWith('.js') || filePath.endsWith('.css') || filePath.endsWith('.woff') || filePath.endsWith('.woff2')) {
                res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
            } else {
                res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            }
        }
    });

    // Return middleware that handles /viewer/* routes (except API)
    return (req, res, next) => {
        if (req.path.startsWith('/viewer')) {
            // Strip Outlook Safe Links debris and tracking query params
            // before any other processing. Mirrors xregistry/viewer#18,
            // ported into the composite bridge deployment which serves
            // the viewer SPA directly rather than via the standalone
            // viewer's express server.
            if (req.method === 'GET' || req.method === 'HEAD') {
                const cleanedUrl = cleanViewerUrl(req);
                if (cleanedUrl !== null) {
                    if (logger) {
                        logger.info('Stripped tracking debris from viewer URL', {
                            originalUrl: req.originalUrl,
                            cleanedUrl
                        });
                    }
                    return res.redirect(302, cleanedUrl);
                }
            }

            // Skip static serving for API routes
            if (req.path.startsWith('/viewer/api/')) {
                return next();
            }
            
            // Intercept config.json requests to inject the deployed registry endpoint
            if (req.path === '/viewer/config.json') {
                const apiBaseUrl = getApiBaseUrl(req);
                const configPath = path.join(viewerPath, 'config.json');
                
                try {
                    // Read the default config.json from the viewer dist
                    let config: any = { apiEndpoints: [], modelUris: [], baseUrl: '/viewer', defaultDocumentView: true };
                    
                    if (fs.existsSync(configPath)) {
                        const configContent = fs.readFileSync(configPath, 'utf-8');
                        config = JSON.parse(configContent);
                    }
                    
                    // Override apiEndpoints with the deployed registry endpoint
                    config.apiEndpoints = [apiBaseUrl];
                    
                    if (logger) {
                        logger.info('Serving dynamically generated config.json for viewer', {
                            apiBaseUrl,
                            originalEndpoints: fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf-8')).apiEndpoints?.length : 0
                        });
                    }
                    
                    res.setHeader('Content-Type', 'application/json; charset=utf-8');
                    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
                    return res.json(config);
                } catch (error) {
                    if (logger) {
                        logger.error('Failed to generate dynamic config.json', { error });
                    }
                    return next();
                }
            }
            
            // Remove /viewer prefix for static file serving
            req.url = req.url.replace(/^\/viewer/, '');
            
            // For Angular routing, serve index.html for non-file requests (SPA fallback)
            if (options.indexFallback && !path.extname(req.url)) {
                req.url = '/index.html';
            }
            
            // If URL is empty after removing prefix, serve index
            if (!req.url || req.url === '/') {
                req.url = '/index.html';
            }
            
            staticMiddleware(req, res, next);
        } else {
            next();
        }
    };
}
