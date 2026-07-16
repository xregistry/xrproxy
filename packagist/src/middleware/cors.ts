/**
 * CORS middleware – permissive read-only policy for xRegistry Packagist wrapper.
 */

import { NextFunction, Request, Response } from 'express';

export function corsMiddleware(req: Request, res: Response, next: NextFunction): void {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers',
        'Accept, Authorization, Cache-Control, Content-Type, If-None-Match, User-Agent');
    res.setHeader('Access-Control-Expose-Headers', 'Cache-Control, Content-Length, ETag, Link');
    res.setHeader('Access-Control-Max-Age', '86400');

    if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
    }
    next();
}
