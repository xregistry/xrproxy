/**
 * xRegistry utility functions for generating compliant entities and handling xRegistry operations.
 */

import { Request } from 'express';
import { getBaseUrl as getBaseUrlFromRequest, REGISTRY_CONFIG } from '../config/constants';
import { XRegistryEntity } from '../types/xregistry';

export interface EntityGenerationOptions {
    id: string;
    name?: string;
    description?: string;
    parentUrl: string;
    type: string;
    labels?: Record<string, string>;
    documentation?: string;
    req?: Request;
}

export interface SimpleEntityOptions {
    xid: string;
    self: string;
    id?: string;
    name?: string;
    description?: string;
    docs?: string;
    tags?: Record<string, string>;
    xRegistry?: any;
    req?: Request;
}

export function generateXRegistryEntity(options: EntityGenerationOptions): XRegistryEntity;
export function generateXRegistryEntity(options: SimpleEntityOptions): XRegistryEntity;
export function generateXRegistryEntity(options: EntityGenerationOptions | SimpleEntityOptions): XRegistryEntity {
    if ('xid' in options && 'self' in options) {
        const simpleOptions = options as SimpleEntityOptions;
        const now = new Date().toISOString();

        const entity: XRegistryEntity & Record<string, any> = {
            xid: simpleOptions.xid,
            name: simpleOptions.name || simpleOptions.id || 'Unnamed',
            self: simpleOptions.self,
            epoch: 1,
            createdat: now,
            modifiedat: now,
        };

        if (simpleOptions.id !== undefined) {
            entity['id'] = simpleOptions.id;
        }
        if (simpleOptions.description !== undefined) {
            entity.description = simpleOptions.description;
        }
        if (simpleOptions.docs !== undefined) {
            entity.documentation = simpleOptions.docs;
        }
        if (simpleOptions.tags !== undefined) {
            entity['tags'] = simpleOptions.tags;
        }
        if (simpleOptions.xRegistry !== undefined) {
            entity['xRegistry'] = simpleOptions.xRegistry;
        }

        return entity;
    }

    const { id, name, description, parentUrl, labels, documentation, req } = options as EntityGenerationOptions;
    const xid = `${parentUrl}/${id}`;
    const baseUrl = getBaseUrl(req);
    const self = `${baseUrl}${xid}`;
    const now = new Date().toISOString();

    const entity: XRegistryEntity = {
        xid,
        name: name || id,
        self,
        epoch: 1,
        createdat: now,
        modifiedat: now,
    };

    if (description !== undefined) {
        entity.description = description;
    }
    if (labels !== undefined) {
        entity.labels = labels;
    }
    if (documentation !== undefined) {
        entity.documentation = documentation;
    }

    return entity;
}

export function createXRegistryEntity(options: SimpleEntityOptions): XRegistryEntity & Record<string, any> {
    const now = new Date().toISOString();

    const entity: XRegistryEntity & Record<string, any> = {
        xid: options.xid,
        name: options.name || options.id || 'Unnamed',
        self: options.self,
        epoch: 1,
        createdat: now,
        modifiedat: now,
    };

    if (options.id !== undefined) {
        entity['id'] = options.id;
    }
    if (options.description !== undefined) {
        entity.description = options.description;
    }
    if (options.docs !== undefined) {
        entity.documentation = options.docs;
    }
    if (options.tags !== undefined) {
        entity['tags'] = options.tags;
    }
    if (options.xRegistry !== undefined) {
        entity['xRegistry'] = options.xRegistry;
    }

    return entity;
}

export function handleInlineFlag(req: any, entity: any): any {
    const inline = req.query?.inline;
    if (!inline) return entity;

    const result = { ...entity };

    if (inline === 'true' || inline === '1') {
        result._inlined = true;
    } else {
        const depth = parseInt(inline, 10);
        if (!isNaN(depth)) {
            result._inlineDepth = depth;
        }
    }

    return result;
}

export function handleEpochFlag(req: any, entity: any): any {
    const noepoch = req.query?.noepoch;
    if (!noepoch || noepoch !== 'true') return entity;

    const result = { ...entity };
    delete result.epoch;
    return result;
}

export function handleNoReadonlyFlag(req: any, entity: any): any {
    const noreadonly = req.query?.noreadonly;
    if (!noreadonly || noreadonly !== 'true') return entity;

    const result = { ...entity };
    delete result.createdat;
    delete result.modifiedat;
    delete result.readonly;
    return result;
}

export function handleSchemaFlag(req: any, entity: any, type: string): any {
    const schema = req.query?.schema;
    if (!schema || schema !== 'true') return entity;

    const result = { ...entity };
    result.$schema = `${REGISTRY_CONFIG.SCHEMA_VERSION}/${type}`;
    return result;
}

export function generateETag(entity: any): string {
    const content = JSON.stringify(entity);
    const hash = simpleHash(content);
    const modifiedAt = entity.modifiedat || new Date().toISOString();
    return `"${hash}-${new Date(modifiedAt).getTime()}"`;
}

export function isValidXRegistryId(xid: string): boolean {
    if (!xid || typeof xid !== 'string') {
        return false;
    }

    if (!xid.startsWith('/')) {
        return false;
    }

    return /^\/[-a-zA-Z0-9._~@/]*$/.test(xid);
}

export function isValidSelfUrl(self: string): boolean {
    if (!self || typeof self !== 'string') {
        return false;
    }

    try {
        const url = new URL(self);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
        return false;
    }
}

export function generatePaginationLinks(
    req: Request,
    totalCount: number,
    offset: number,
    limit: number
): string {
    const protocol = req.protocol || 'http';
    const host = req.get('host') || 'localhost:3100';
    const path = req.path || '';
    const baseUrl = `${protocol}://${host}${path}`;
    const query = new URLSearchParams(req.query as Record<string, string>);

    const links: string[] = [];

    if (offset > 0) {
        query.set('offset', '0');
        query.set('limit', limit.toString());
        links.push(`<${baseUrl}?${query.toString()}>; rel="first"`);
    }

    if (offset > 0) {
        const prevOffset = Math.max(0, offset - limit);
        query.set('offset', prevOffset.toString());
        query.set('limit', limit.toString());
        links.push(`<${baseUrl}?${query.toString()}>; rel="prev"`);
    }

    if (offset + limit < totalCount) {
        const nextOffset = offset + limit;
        query.set('offset', nextOffset.toString());
        query.set('limit', limit.toString());
        links.push(`<${baseUrl}?${query.toString()}>; rel="next"`);
    }

    if (offset + limit < totalCount) {
        const lastOffset = Math.floor((totalCount - 1) / limit) * limit;
        query.set('offset', lastOffset.toString());
        query.set('limit', limit.toString());
        links.push(`<${baseUrl}?${query.toString()}>; rel="last"`);
    }

    links.push(`count="${totalCount}"`);
    links.push(`per-page="${limit}"`);

    return links.join(', ');
}

export function setXRegistryHeaders(res: any, entity: any): void {
    res.set('Content-Type', 'application/json');
    res.set('xRegistry-Version', REGISTRY_CONFIG.SPEC_VERSION);

    if (entity && entity.modifiedat) {
        res.set('ETag', generateETag(entity));
    }

    res.set('Cache-Control', 'public, max-age=300');
}

export function parseFilterExpressions(filterParam: string | string[]): Array<{
    attribute: string;
    operator: string;
    value: string;
}> {
    const filters: Array<{ attribute: string; operator: string; value: string }> = [];
    const filterStrings = Array.isArray(filterParam) ? filterParam : [filterParam];

    for (const filterStr of filterStrings) {
        const match = filterStr.match(/^([a-zA-Z0-9_\-]+)(=|!=|~|!~)(.*)$/);
        if (match && match[1] && match[2] && match[3] !== undefined) {
            filters.push({
                attribute: match[1],
                operator: match[2],
                value: match[3],
            });
        }
    }

    return filters;
}

function getBaseUrl(req?: Request): string {
    if (req) {
        return getBaseUrlFromRequest(req);
    }
    return process.env['BASE_URL'] || 'http://localhost:3100';
}

function simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return Math.abs(hash).toString(36);
}
