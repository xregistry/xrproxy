/**
 * xRegistry error-handling middleware and async route wrapper.
 */

import { NextFunction, Request, Response } from 'express';
import { entityNotFound, isXRegistryError, XRegistryError } from '../utils/xregistry-errors';

export function asyncHandler(
    fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
) {
    return (req: Request, res: Response, next: NextFunction): void => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
}

export function throwEntityNotFound(instance: string, type: string, id: string): never {
    throw entityNotFound(instance, type, id);
}

export function xregistryErrorHandler(
    err: unknown,
    req: Request,
    res: Response,
    _next: NextFunction,
): void {
    if (isXRegistryError(err)) {
        const e = err as XRegistryError;
        res.status(e.status).json(e);
        return;
    }
    // Generic fallback
    const detail = err instanceof Error ? err.message : String(err);
    res.status(500).json({
        type: 'about:blank',
        title: 'Internal Server Error',
        status: 500,
        instance: req.originalUrl,
        detail,
    });
}
