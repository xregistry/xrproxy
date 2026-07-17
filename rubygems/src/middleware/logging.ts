import { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';

declare global {
    namespace Express {
        interface Request {
            requestId?: string;
            startTime?: number;
        }
    }
}

export function createLoggingMiddleware() {
    return (req: Request, res: Response, next: NextFunction): void => {
        req.requestId = randomUUID();
        req.startTime = Date.now();

        res.on('finish', () => {
            const durationMs = Date.now() - (req.startTime ?? Date.now());
            const output = {
                requestId: req.requestId,
                method: req.method,
                path: req.originalUrl,
                status: res.statusCode,
                durationMs,
            };
            if (res.statusCode >= 500) {
                console.error('[ERROR] request completed', output);
            } else {
                console.log('[INFO] request completed', output);
            }
        });

        next();
    };
}
