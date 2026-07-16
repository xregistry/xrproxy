import { NextFunction, Request, Response } from 'express';
import { PAGINATION } from '../config/constants';

export interface XRegistryRequestFlags {
    inline: string[];
    filter?: string;
    offset: number;
    limit: number;
    search?: string;
}

function firstString(value: unknown): string | undefined {
    if (typeof value === 'string') {
        return value;
    }
    if (Array.isArray(value)) {
        const first = value[0];
        return typeof first === 'string' ? first : undefined;
    }
    return undefined;
}

function parseInteger(value: unknown, fallback: number): number {
    const raw = firstString(value);
    if (!raw) {
        return fallback;
    }
    const parsed = Number.parseInt(raw, 10);
    if (Number.isNaN(parsed) || parsed < 0) {
        return fallback;
    }
    return parsed;
}

export function parseRequestFlags(query: Request['query']): XRegistryRequestFlags {
    const inlineRaw = firstString(query['inline']);
    const inline = inlineRaw
        ? inlineRaw.split(',').map((part) => part.trim()).filter((part) => part.length > 0)
        : [];

    const offset = parseInteger(query['offset'], 0);
    const limit = Math.min(
        Math.max(parseInteger(query['limit'], PAGINATION.DEFAULT_LIMIT), 1),
        PAGINATION.MAX_LIMIT,
    );

    const filter = firstString(query['filter']);
    const search = firstString(query['search']);

    return {
        inline,
        ...(filter ? { filter } : {}),
        offset,
        limit,
        ...(search && search.trim() ? { search: search.trim() } : {}),
    };
}

export function parseXRegistryFlags(req: Request, _res: Response, next: NextFunction): void {
    req.xregistryFlags = parseRequestFlags(req.query);
    next();
}

export function includesInline(flags: XRegistryRequestFlags | undefined, target: string): boolean {
    if (!flags) {
        return false;
    }
    return flags.inline.includes('*') || flags.inline.includes(target);
}

declare global {
    namespace Express {
        interface Request {
            xregistryFlags?: XRegistryRequestFlags;
        }
    }
}
