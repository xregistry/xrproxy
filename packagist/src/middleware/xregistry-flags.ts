/**
 * xRegistry query-parameter flags middleware.
 * Parses ?inline, ?filter, ?sort, ?epoch per xRegistry 1.0-rc2.
 */

import { NextFunction, Request, Response } from 'express';

export interface XRegistryFlags {
    inline?: string[];
    filter?: string[][];
    sort?: { attribute: string; direction: 'asc' | 'desc' };
    epoch?: number;
}

export function getNamePrefixFilter(filter: string[][] | undefined): string | undefined {
    if (filter?.length !== 1 || filter[0]?.length !== 1) return undefined;
    const match = filter[0][0]?.match(/^name=(.+)\*$/i);
    return match?.[1]?.trim() || undefined;
}

declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace Express {
        interface Request {
            xregistryFlags?: XRegistryFlags;
        }
    }
}

function parseInline(v: string | string[] | undefined): string[] | undefined {
    if (!v) return undefined;
    const values = Array.isArray(v) ? v : [v];
    const paths: string[] = [];
    for (const item of values) {
        if (item === '*') return ['*'];
        paths.push(...item.split(',').map(p => p.trim()).filter(Boolean));
    }
    return paths.length > 0 ? paths : undefined;
}

function parseFilter(v: string | string[] | undefined): string[][] | undefined {
    if (!v) return undefined;
    const values = Array.isArray(v) ? v : [v];
    return values.map(group => group.split(',').map(e => e.trim()).filter(Boolean));
}

function parseSort(v: string | string[] | undefined): XRegistryFlags['sort'] | undefined {
    if (!v || Array.isArray(v)) return undefined;
    const [attr, dir] = v.split('=');
    return {
        attribute: attr ?? '',
        direction: dir === 'desc' ? 'desc' : 'asc',
    };
}

export function parseXRegistryFlags(req: Request, _res: Response, next: NextFunction): void {
    const q = req.query as Record<string, string | string[] | undefined>;
    const flags: XRegistryFlags = {};
    const inline = parseInline(q['inline']);
    if (inline) flags.inline = inline;
    const filter = parseFilter(q['filter']);
    if (filter) flags.filter = filter;
    const sort = parseSort(q['sort'] as string | undefined);
    if (sort) flags.sort = sort;
    const epoch = q['epoch'] ? parseInt(q['epoch'] as string, 10) : undefined;
    if (epoch !== undefined && !isNaN(epoch)) flags.epoch = epoch;
    req.xregistryFlags = flags;
    next();
}

/** Apply a simple filter to an array of objects. Supports attr=value and attr!=value. */
export function applyFilter<T extends Record<string, unknown>>(
    items: T[],
    filter: string[][],
): T[] {
    return items.filter(item =>
        filter.some(andGroup =>
            andGroup.every(expr => {
                const neq = expr.includes('!=');
                const [attr, val] = neq ? expr.split('!=') : expr.split('=');
                const attrKey = (attr ?? '').trim();
                const valStr = (val ?? '').trim().toLowerCase();
                const itemVal = String(item[attrKey] ?? '').toLowerCase();
                const matches = valStr.endsWith('*')
                    ? itemVal.startsWith(valStr.slice(0, -1))
                    : itemVal.includes(valStr);
                return neq ? !matches : matches;
            }),
        ),
    );
}

/** Apply sort to an array of objects. */
export function applySort<T extends Record<string, unknown>>(
    items: T[],
    sort: NonNullable<XRegistryFlags['sort']>,
): T[] {
    const { attribute, direction } = sort;
    return [...items].sort((a, b) => {
        const av = String(a[attribute] ?? '');
        const bv = String(b[attribute] ?? '');
        const cmp = av.localeCompare(bv);
        return direction === 'desc' ? -cmp : cmp;
    });
}
