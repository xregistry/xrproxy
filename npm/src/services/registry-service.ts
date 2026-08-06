/**
 * Registry Service
 * @fileoverview Service implementing xRegistry-compliant endpoints for npm packages.
 */

import { Request, Response } from 'express';
import { CacheService } from '../cache/cache-service';
import { GROUP_CONFIG, NPM_REGISTRY, PAGINATION, RESOURCE_CONFIG } from '../config/constants';
import { throwEntityNotFound, throwInternalError } from '../middleware/xregistry-error-handler';
import { applyFilterFlag, applySortFlag } from '../middleware/xregistry-flags';
import { XRegistryEntity, XRegistryGroupResponse, XRegistryResourceResponse } from '../types/xregistry';
import {
    createXRegistryEntity,
    generateETag,
    handleEpochFlag,
    handleInlineFlag,
    handleNoReadonlyFlag,
    handleSchemaFlag,
} from '../utils/xregistry-utils';
import { NpmService } from './npm-service';
import { getNodescopeId, normalizePackageId } from '../utils/package-utils';

export interface RegistryServiceOptions {
    npmService: NpmService;
    cacheService: CacheService;
    logger?: any;
}

export class RegistryService {
    private readonly npmService: NpmService;
    // @ts-ignore - reserved for future use
    private readonly cacheService: CacheService;
    private readonly logger: any;

    constructor(options: RegistryServiceOptions) {
        this.npmService = options.npmService;
        this.cacheService = options.cacheService;
        this.logger = options.logger || console;
    }

    async getRegistry(req: Request, res: Response): Promise<void> {
        try {
            const baseUrl = `${req.protocol}://${req.get('host')}`;
            const scopeMap = await this.buildScopeMap();
            let registryEntity: XRegistryEntity & Record<string, any> = createXRegistryEntity({
                xid: '/',
                self: baseUrl,
                name: 'NPM Registry Service',
                description: 'xRegistry-compliant npm package registry',
                docs: 'https://docs.npmjs.com/',
            });

            registryEntity['specversion'] = '1.0-rc2';
            registryEntity['registryid'] = 'npm-wrapper';
            registryEntity['nodescopesurl'] = `${baseUrl}/${GROUP_CONFIG.TYPE}`;
            registryEntity['nodescopescount'] = scopeMap.size;
            registryEntity['modelurl'] = `${baseUrl}/model`;
            registryEntity['capabilitiesurl'] = `${baseUrl}/capabilities`;

            const shouldInline = req.query['inline'] === 'true' || req.query['inline'] === '1';
            if (shouldInline) {
                registryEntity[GROUP_CONFIG.TYPE] = await this.getGroupsInline(req);
            }

            registryEntity = handleInlineFlag(req, registryEntity);
            registryEntity = handleEpochFlag(req, registryEntity);
            registryEntity = handleNoReadonlyFlag(req, registryEntity);
            registryEntity = handleSchemaFlag(req, registryEntity, 'registry');

            res.set('ETag', generateETag(registryEntity));
            res.set('Content-Type', 'application/json');
            res.json(registryEntity);
        } catch (error: any) {
            this.logger.error('Failed to serve registry root', { error: error.message, path: req.path });
            throwInternalError(req.originalUrl, 'Failed to retrieve registry information');
        }
    }

    async getGroups(req: Request, res: Response): Promise<void> {
        try {
            let groups = await this.getGroupsInline(req);
            if (req.xregistryFlags?.filter) {
                groups = applyFilterFlag(groups, req.xregistryFlags.filter) as typeof groups;
            }
            if (req.xregistryFlags?.sort) {
                groups = applySortFlag(groups, req.xregistryFlags.sort) as typeof groups;
            }

            Object.keys(groups).forEach((key) => {
                let processed = handleInlineFlag(req, groups[key]);
                processed = handleEpochFlag(req, processed);
                processed = handleNoReadonlyFlag(req, processed);
                groups[key] = processed;
            });

            const response: XRegistryGroupResponse = { [GROUP_CONFIG.TYPE]: groups };
            res.set('ETag', generateETag(response));
            res.set('Content-Type', 'application/json');
            res.json(response);
        } catch (error: any) {
            this.logger.error('Failed to serve groups collection', { error: error.message, path: req.path });
            throwInternalError(req.originalUrl, 'Failed to retrieve groups');
        }
    }

    async getGroup(req: Request, res: Response): Promise<void> {
        try {
            const nodescopeId = this.getNodescopeIdParam(req);
            const scopeMap = await this.buildScopeMap();
            if (!scopeMap.has(nodescopeId)) {
                throwEntityNotFound(req.originalUrl, 'group', nodescopeId);
            }

            let groupEntity = this.createGroupEntity(req, nodescopeId, scopeMap.get(nodescopeId) || 0);
            const shouldInline = req.query['inline'] === 'true' || req.query['inline'] === '1';
            if (shouldInline) {
                groupEntity['packages'] = await this.getResourcesInline(req, nodescopeId);
            }

            groupEntity = handleInlineFlag(req, groupEntity);
            groupEntity = handleEpochFlag(req, groupEntity);
            groupEntity = handleNoReadonlyFlag(req, groupEntity);

            res.set('ETag', generateETag(groupEntity));
            res.set('Content-Type', 'application/json');
            res.json(groupEntity);
        } catch (error: any) {
            this.logger.error('Failed to serve group', { error: error.message, path: req.path });
            throwInternalError(req.originalUrl, 'Failed to retrieve group');
        }
    }

    async getResources(req: Request, res: Response): Promise<void> {
        try {
            const nodescopeId = this.getNodescopeIdParam(req);
            const scopeMap = await this.buildScopeMap();
            if (!scopeMap.has(nodescopeId)) {
                throwEntityNotFound(req.originalUrl, 'group', nodescopeId);
            }

            let resources = await this.getResourcesInline(req, nodescopeId);
            if (req.xregistryFlags?.filter) {
                resources = applyFilterFlag(resources, req.xregistryFlags.filter) as typeof resources;
            }
            if (req.xregistryFlags?.sort) {
                resources = applySortFlag(resources, req.xregistryFlags.sort) as typeof resources;
            }

            Object.keys(resources).forEach((key) => {
                let processed = handleInlineFlag(req, resources[key]);
                processed = handleEpochFlag(req, processed);
                processed = handleNoReadonlyFlag(req, processed);
                resources[key] = processed;
            });

            const response: XRegistryResourceResponse = { [RESOURCE_CONFIG.TYPE]: resources };
            res.set('ETag', generateETag(response));
            res.set('Content-Type', 'application/json');
            res.json(response);
        } catch (error: any) {
            this.logger.error('Failed to serve resources collection', { error: error.message, path: req.path });
            throwInternalError(req.originalUrl, 'Failed to retrieve resources');
        }
    }

    async getResource(req: Request, res: Response): Promise<void> {
        try {
            const nodescopeId = this.getNodescopeIdParam(req);
            const packageId = this.getPackageIdParam(req);
            const canonicalName = await this.resolvePackageName(nodescopeId, packageId);
            if (!canonicalName) {
                throwEntityNotFound(req.originalUrl, 'package', packageId);
            }

            const packageMetadata = await this.npmService.getPackageMetadata(canonicalName);
            if (!packageMetadata) {
                throwEntityNotFound(req.originalUrl, 'package', packageId);
            }

            const self = `${req.protocol}://${req.get('host')}${req.originalUrl.split('?')[0]}`;
            let packageEntity: XRegistryEntity & Record<string, any> = {
                ...packageMetadata,
                xid: `/${GROUP_CONFIG.TYPE}/${nodescopeId}/${RESOURCE_CONFIG.TYPE}/${packageId}`,
                self,
                packageid: packageId,
                versionsurl: `${self}/versions`,
                metaurl: `${self}/meta`,
                versionscount: Object.keys(packageMetadata.versions || {}).length,
            };

            packageEntity = handleInlineFlag(req, packageEntity);
            packageEntity = handleEpochFlag(req, packageEntity);
            packageEntity = handleNoReadonlyFlag(req, packageEntity);

            res.set('ETag', generateETag(packageEntity));
            res.set('Content-Type', 'application/json');
            res.json(packageEntity);
        } catch (error: any) {
            this.logger.error('Failed to serve resource', { error: error.message, path: req.path });
            throwInternalError(req.originalUrl, 'Failed to retrieve resource');
        }
    }

    private async buildScopeMap(): Promise<Map<string, number>> {
        const packageNames = await this.npmService.getKnownPackageNames();
        const scopeMap = new Map<string, number>([[GROUP_CONFIG.UNSCOPED_ID, 0]]);

        for (const packageName of packageNames) {
            const nodescopeId = getNodescopeId(packageName);
            scopeMap.set(nodescopeId, (scopeMap.get(nodescopeId) || 0) + 1);
        }

        return scopeMap;
    }

    private createGroupEntity(req: Request, nodescopeId: string, packageCount: number): XRegistryEntity & Record<string, any> {
        const baseUrl = `${req.protocol}://${req.get('host')}`;
        const xid = `/${GROUP_CONFIG.TYPE}/${nodescopeId}`;
        const entity = createXRegistryEntity({
            xid,
            self: `${baseUrl}${xid}`,
            id: nodescopeId,
            name: nodescopeId === GROUP_CONFIG.UNSCOPED_ID ? 'unscoped packages' : `@${nodescopeId}`,
            description: nodescopeId === GROUP_CONFIG.UNSCOPED_ID ? 'Flat namespace of unscoped npm packages' : `npm scope @${nodescopeId}`,
        });

        entity['nodescopeid'] = nodescopeId;
        entity['packagesurl'] = `${baseUrl}${xid}/${RESOURCE_CONFIG.TYPE}`;
        entity['packagescount'] = packageCount;
        entity['sourceurl'] = NPM_REGISTRY.BASE_URL;
        if (nodescopeId !== GROUP_CONFIG.UNSCOPED_ID) {
            entity['scope'] = nodescopeId;
        }
        return entity;
    }

    private async getGroupsInline(req: Request): Promise<Record<string, XRegistryEntity>> {
        const scopeMap = await this.buildScopeMap();
        const groups: Record<string, XRegistryEntity> = {};

        Array.from(scopeMap.keys()).sort().forEach((nodescopeId) => {
            groups[nodescopeId] = this.createGroupEntity(req, nodescopeId, scopeMap.get(nodescopeId) || 0);
        });

        return groups;
    }

    private async getResourcesInline(req: Request, nodescopeId: string): Promise<Record<string, XRegistryEntity>> {
        const packageNames = await this.npmService.getKnownPackageNames();
        const offset = Number(req.query['offset'] || 0);
        const limit = Number(req.query['limit'] || PAGINATION.DEFAULT_PAGE_LIMIT);
        const filtered = packageNames.filter((packageName) => getNodescopeId(packageName) === nodescopeId);
        const page = filtered.slice(offset, offset + limit);
        const baseUrl = `${req.protocol}://${req.get('host')}`;
        const resources: Record<string, XRegistryEntity> = {};

        page.forEach((packageName) => {
            const packageId = normalizePackageId(packageName);
            resources[packageId] = createXRegistryEntity({
                xid: `/${GROUP_CONFIG.TYPE}/${nodescopeId}/${RESOURCE_CONFIG.TYPE}/${packageId}`,
                self: `${baseUrl}/${GROUP_CONFIG.TYPE}/${nodescopeId}/${RESOURCE_CONFIG.TYPE}/${packageId}`,
                id: packageId,
                name: packageName,
                description: packageName,
            });
            resources[packageId]['packageid'] = packageId;
        });

        return resources;
    }

    private async resolvePackageName(nodescopeId: string, packageId: string): Promise<string | null> {
        return this.npmService.resolveCanonicalPackageName(nodescopeId, packageId);
    }

    private getNodescopeIdParam(req: Request): string {
        return req.params['nodescopeId'] || req.params['groupId'] || '';
    }

    private getPackageIdParam(req: Request): string {
        return req.params['packageId'] || req.params['resourceId'] || req.params['packageName'] || '';
    }
}
