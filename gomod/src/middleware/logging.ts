/**
 * Request / response logging middleware
 */

import { NextFunction, Request, Response } from 'express';

export function loggingMiddleware(req: Request, res: Response, next: NextFunction): void {
    const start = Date.now();
    res.on('finish', () => {
        const ms = Date.now() - start;
        const level = res.statusCode >= 500 ? 'ERROR' : res.statusCode >= 400 ? 'WARN' : 'INFO';
        process.stdout.write(
            `[${level}] ${req.method} ${req.originalUrl} → ${res.statusCode} (${ms}ms)\n`
        );
    });
    next();
}
