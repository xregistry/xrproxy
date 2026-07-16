/**
 * Structured request/response logging middleware.
 */

import { NextFunction, Request, Response } from 'express';

export interface SimpleLogger {
    info(msg: string, data?: unknown): void;
    warn(msg: string, data?: unknown): void;
    error(msg: string, data?: unknown): void;
    debug(msg: string, data?: unknown): void;
}

export function createSimpleLogger(): SimpleLogger {
    const fmt = (level: string, msg: string, data?: unknown) =>
        `[${new Date().toISOString()}] ${level}: ${msg}` + (data !== undefined ? ' ' + JSON.stringify(data) : '');

    return {
        info: (m, d?) => console.info(fmt('INFO', m, d)),
        warn: (m, d?) => console.warn(fmt('WARN', m, d)),
        error: (m, d?) => console.error(fmt('ERROR', m, d)),
        debug: (m, d?) => process.env['LOG_LEVEL'] === 'debug' && console.debug(fmt('DEBUG', m, d)),
    };
}

export const logger = createSimpleLogger();

export function createLoggingMiddleware(log: SimpleLogger) {
    return (req: Request, res: Response, next: NextFunction): void => {
        if (['/health'].includes(req.path)) { next(); return; }

        const start = Date.now();
        const id = `req_${start}_${Math.random().toString(36).slice(2, 7)}`;
        res.setHeader('X-Request-ID', id);

        log.info(`→ ${req.method} ${req.path}`, { id });

        res.on('finish', () => {
            const ms = Date.now() - start;
            const fn = res.statusCode >= 400 ? 'warn' : 'info';
            log[fn](`← ${res.statusCode} ${req.method} ${req.path}`, { id, ms });
        });

        next();
    };
}
