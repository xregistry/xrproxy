/**
 * CORS middleware
 */

import { NextFunction, Request, Response } from 'express';

export function corsMiddleware(req: Request, res: Response, next: NextFunction): void {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader(
        'Access-Control-Allow-Methods',
        'GET, HEAD, OPTIONS'
    );
    res.setHeader(
        'Access-Control-Allow-Headers',
        'Accept, Accept-Language, Content-Language, Content-Type, Authorization, x-base-url'
    );
    res.setHeader('Access-Control-Expose-Headers', 'Link, Content-Type, X-Total-Count');

    if (req.method === 'OPTIONS') {
        res.sendStatus(204);
        return;
    }
    next();
}
