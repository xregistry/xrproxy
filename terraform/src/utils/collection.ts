import { Request, Response } from 'express';
import { getBaseUrl, SERVER_CONFIG } from '../config/constants';

export function queryString(req: Request, name: string): string | undefined {
    const value = req.query[name];
    return typeof value === 'string' ? value : Array.isArray(value) && typeof value[0] === 'string' ? value[0] : undefined;
}

export function parsePagination(req: Request): { offset: number; limit: number } {
    const rawLimit = Number.parseInt(queryString(req, 'limit') ?? String(SERVER_CONFIG.DEFAULT_PAGE_LIMIT), 10);
    const rawOffset = Number.parseInt(queryString(req, 'offset') ?? '0', 10);
    return {
        limit: Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : SERVER_CONFIG.DEFAULT_PAGE_LIMIT,
        offset: Number.isFinite(rawOffset) ? Math.max(rawOffset, 0) : 0,
    };
}

export function matchesWildcard(value: string, pattern: string): boolean {
    const source = pattern.split('*')
        .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*');
    return new RegExp(`^${source}$`, 'i').test(value);
}

export interface EntityFilter {
    attribute: string;
    pattern: string;
}

export function parseEntityFilter(value: string | undefined): EntityFilter | undefined | null {
    if (value === undefined) return undefined;
    const match = /^([a-z][a-z0-9_]*)=(.+)$/i.exec(value);
    return match ? { attribute: match[1]!.toLowerCase(), pattern: match[2]! } : null;
}

export function matchesEntityFilter(entity: Record<string, unknown>, filter: EntityFilter | undefined): boolean {
    if (!filter) return true;
    const value = entity[filter.attribute];
    return value !== undefined && value !== null && matchesWildcard(String(value), filter.pattern);
}

export function sortEntities(
    entities: readonly Record<string, unknown>[],
    sort: string | undefined,
): Record<string, unknown>[] {
    if (!sort) return [...entities];
    const [rawAttribute, direction] = sort.split('=');
    const attribute = (rawAttribute ?? '').toLowerCase();
    const multiplier = direction?.toLowerCase() === 'desc' ? -1 : 1;
    return [...entities].sort((a, b) => String(a[attribute] ?? '').localeCompare(String(b[attribute] ?? '')) * multiplier);
}

export function setPaginationHeaders(
    req: Request,
    res: Response,
    offset: number,
    limit: number,
    totalCount: number,
    complete = true,
): void {
    res.setHeader('X-Collection-Complete', String(complete));
    if (complete) res.setHeader('X-Total-Count', String(totalCount));
    if (totalCount <= limit && offset === 0) return;
    const makeUrl = (targetOffset: number): string => {
        const query = new URLSearchParams();
        for (const [name, value] of Object.entries(req.query)) {
            if (typeof value === 'string') query.set(name, value);
        }
        query.set('offset', String(targetOffset));
        query.set('limit', String(limit));
        return `${getBaseUrl(req)}${req.path}?${query}`;
    };
    const links: string[] = [];
    if (offset > 0) {
        links.push(`<${makeUrl(0)}>; rel="first"`);
        links.push(`<${makeUrl(Math.max(0, offset - limit))}>; rel="prev"`);
    }
    if (offset + limit < totalCount) {
        links.push(`<${makeUrl(offset + limit)}>; rel="next"`);
        if (complete) {
            const last = Math.floor((totalCount - 1) / limit) * limit;
            links.push(`<${makeUrl(last)}>; rel="last"`);
        }
    }
    if (links.length) res.setHeader('Link', links.join(', '));
}
