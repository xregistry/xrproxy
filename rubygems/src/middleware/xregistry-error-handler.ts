import { NextFunction, Request, Response } from 'express';
import { errorToXRegistryError, entityNotFound, internalError, invalidData, ProblemDetailsError, serviceUnavailable } from '../utils/xregistry-errors';

export function asyncHandler(
    fn: (req: Request, res: Response, next: NextFunction) => Promise<void>
) {
    return (req: Request, res: Response, next: NextFunction): void => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
}

export function throwEntityNotFound(instance: string, entityType: string, id: string): never {
    throw entityNotFound(instance, entityType, id);
}

export function throwInvalidData(instance: string, attribute: string, reason: string): never {
    throw invalidData(instance, attribute, reason);
}

export function throwInternalError(instance: string, detail?: string): never {
    throw internalError(instance, detail);
}

export function throwServiceUnavailable(instance: string, detail?: string): never {
    throw serviceUnavailable(instance, detail);
}

export function isProblemDetailsError(error: unknown): error is ProblemDetailsError {
    return error instanceof ProblemDetailsError;
}

export function xregistryErrorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void {
    if (res.headersSent) {
        next(err);
        return;
    }

    const problem = errorToXRegistryError(err, req.originalUrl || req.path);
    if (process.env['NODE_ENV'] === 'development' && err instanceof Error && err.stack) {
        (problem as ProblemDetailsError & { stack?: string }).stack = err.stack;
    }

    res.status(problem.status).type('application/problem+json').json(problem);
}
