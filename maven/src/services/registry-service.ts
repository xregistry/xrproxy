/**
 * Registry Service
 * @fileoverview xRegistry-compliant registry endpoints for Maven
 */

import { Request, Response } from 'express';
import modelData from '../../model.json';
import { EntityStateManager } from '../../../shared/entity-state-manager';
import { getBaseUrl, GROUP_CONFIG, MAVEN_REGISTRY, RESOURCE_CONFIG, XREGISTRY_CONFIG } from '../config/constants';
import { throwEntityNotFound } from '../middleware/xregistry-error-handler';
import { SearchService } from './search-service';

export interface RegistryServiceOptions {
    baseUrl?: string;
    entityState?: EntityStateManager;
    searchService: SearchService;
}

export class RegistryService {
    private readonly entityState: EntityStateManager;
    private readonly searchService: SearchService;
    private readonly model: any;

    constructor(options: RegistryServiceOptions) {
        this.entityState = options.entityState || new EntityStateManager();
        this.searchService = options.searchService;
        this.model = modelData;
    }

    async getRegistry(req: Request, res: Response): Promise<void> {
        const baseUrl = getBaseUrl(req);
        const registryPath = '/';
        const namespaceCount = (await this.searchService.listNamespaces({ limit: 1, offset: 0 })).totalCount;

        const registry: any = {
            specversion: XREGISTRY_CONFIG.SPEC_VERSION,
            registryid: XREGISTRY_CONFIG.REGISTRY_ID,
            xid: '/',
            self: `${baseUrl}/`,
            xregistryurl: `${baseUrl}/`,
            modelurl: `${baseUrl}/model`,
            capabilitiesurl: `${baseUrl}/capabilities`,
            epoch: this.entityState.getEpoch(registryPath),
            name: 'Maven Central xRegistry',
            description: 'xRegistry projection of Maven Central package namespaces and artifacts',
            documentation: 'https://central.sonatype.com/',
            createdat: this.entityState.getCreatedAt(registryPath),
            modifiedat: this.entityState.getModifiedAt(registryPath),
            javanamespacesurl: `${baseUrl}/${GROUP_CONFIG.TYPE}`,
            javanamespacescount: namespaceCount
        };

        if (req.xregistryFlags?.inline?.includes(GROUP_CONFIG.TYPE)) {
            registry[GROUP_CONFIG.TYPE] = await this.getGroupsInline(req);
        }

        const inlineParam = req.query['inline'];
        if (inlineParam === 'model' || req.xregistryFlags?.inline?.includes('model')) {
            registry.model = this.model;
        }

        res.json(registry);
    }

    async getGroups(req: Request, res: Response): Promise<void> {
        const baseUrl = getBaseUrl(req);
        const limit = parseInt(req.query['limit'] as string) || 50;
        const offset = parseInt(req.query['offset'] as string) || 0;
        const query = this.parseGroupQuery(req.query['q'] as string | undefined, req.query['filter'] as string | undefined);
        const searchOptions: { query?: string; limit: number; offset: number } = { limit, offset };
        if (query) {
            searchOptions.query = query;
        }
        const result = await this.searchService.listNamespaces(searchOptions);
        const groups = await this.buildGroupsMap(result.results, baseUrl);

        res.setHeader('X-Total-Count', String(result.totalCount));
        this.setCollectionLinks(res, `${baseUrl}/${GROUP_CONFIG.TYPE}`, limit, offset, result.totalCount, req.query as Record<string, string | undefined>);
        res.json(groups);
    }

    async getGroup(req: Request, res: Response): Promise<void> {
        const namespaceId = req.params['groupId'];
        const baseUrl = getBaseUrl(req);
        if (!namespaceId) {
            throwEntityNotFound(`/${GROUP_CONFIG.TYPE}/unknown`, GROUP_CONFIG.TYPE_SINGULAR, 'unknown');
        }

        const namespace = await this.searchService.getNamespaceById(namespaceId);
        if (!namespace) {
            throwEntityNotFound(`/${GROUP_CONFIG.TYPE}/${namespaceId}`, GROUP_CONFIG.TYPE_SINGULAR, namespaceId);
        }

        const packagesCount = await this.searchService.countPackagesInNamespace(namespace.groupId);
        const groupPath = `/${GROUP_CONFIG.TYPE}/${namespace.namespaceId}`;

        res.json({
            xid: groupPath,
            self: `${baseUrl}${groupPath}`,
            javanamespaceid: namespace.namespaceId,
            epoch: this.entityState.getEpoch(groupPath),
            createdat: this.entityState.getCreatedAt(groupPath),
            modifiedat: this.entityState.getModifiedAt(groupPath),
            group_id: namespace.groupId,
            sourceurl: MAVEN_REGISTRY.REPO_URL,
            [`${RESOURCE_CONFIG.TYPE}url`]: `${baseUrl}${groupPath}/${RESOURCE_CONFIG.TYPE}`,
            [`${RESOURCE_CONFIG.TYPE}count`]: packagesCount
        });
    }

    async getCapabilities(_req: Request, res: Response): Promise<void> {
        res.json({
            apis: ['/capabilities', '/model', '/export'],
            flags: ['doc', 'epoch', 'filter', 'inline', 'sort', 'specversion'],
            formats: ['xRegistry-json/1.0-rc2'],
            mutable: [],
            pagination: true,
            specversions: ['1.0-rc2']
        });
    }

    async getModel(_req: Request, res: Response): Promise<void> {
        res.json(this.model);
    }

    private async getGroupsInline(req: Request): Promise<Record<string, unknown>> {
        const baseUrl = getBaseUrl(req);
        const result = await this.searchService.listNamespaces({ limit: 50, offset: 0 });
        return this.buildGroupsMap(result.results, baseUrl);
    }

    private async buildGroupsMap(namespaces: Array<{ groupId: string; namespaceId: string }>, baseUrl: string): Promise<Record<string, unknown>> {
        const entries = await Promise.all(namespaces.map(async (namespace) => {
            const groupPath = `/${GROUP_CONFIG.TYPE}/${namespace.namespaceId}`;
            const packagesCount = await this.searchService.countPackagesInNamespace(namespace.groupId);
            return [
                namespace.namespaceId,
                {
                    xid: groupPath,
                    self: `${baseUrl}${groupPath}`,
                    javanamespaceid: namespace.namespaceId,
                    epoch: this.entityState.getEpoch(groupPath),
                    createdat: this.entityState.getCreatedAt(groupPath),
                    modifiedat: this.entityState.getModifiedAt(groupPath),
                    group_id: namespace.groupId,
                    sourceurl: MAVEN_REGISTRY.REPO_URL,
                    packagesurl: `${baseUrl}${groupPath}/${RESOURCE_CONFIG.TYPE}`,
                    packagescount: packagesCount
                }
            ] as const;
        }));

        const groups: Record<string, unknown> = {};
        for (const [namespaceId, group] of entries) {
            groups[namespaceId] = group;
        }
        return groups;
    }

    private parseGroupQuery(query: string | undefined, filter: string | undefined): string | undefined {
        if (query) {
            return query;
        }
        if (!filter) {
            return undefined;
        }
        const match = filter.match(/(?:javanamespaceid|group_id)\s*=\s*'?([^']+)'?/i);
        return match?.[1]?.trim();
    }

    private setCollectionLinks(res: Response, basePath: string, limit: number, offset: number, totalCount: number, query: Record<string, string | undefined>): void {
        if (totalCount <= 0) {
            return;
        }

        const headers: string[] = [];
        const queryParams = new URLSearchParams();
        for (const [key, value] of Object.entries(query)) {
            if (value !== undefined) {
                queryParams.set(key, value);
            }
        }

        if (offset > 0) {
            queryParams.set('offset', '0');
            queryParams.set('limit', String(limit));
            headers.push(`<${basePath}?${queryParams.toString()}>; rel="first"`);
            queryParams.set('offset', String(Math.max(0, offset - limit)));
            headers.push(`<${basePath}?${queryParams.toString()}>; rel="prev"`);
        }

        if (offset + limit < totalCount) {
            queryParams.set('offset', String(offset + limit));
            queryParams.set('limit', String(limit));
            headers.push(`<${basePath}?${queryParams.toString()}>; rel="next"`);
            const lastOffset = Math.floor((totalCount - 1) / limit) * limit;
            queryParams.set('offset', String(lastOffset));
            headers.push(`<${basePath}?${queryParams.toString()}>; rel="last"`);
        }

        if (headers.length > 0) {
            res.setHeader('Link', headers.join(', '));
        }
    }
}
