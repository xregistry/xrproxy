import { Request, Response } from 'express';
import { EntityStateManager } from '../../../shared/entity-state-manager';
import * as modelData from '../../model.json';
import { getBaseUrl, GROUP_CONFIG, PAGINATION, REGISTRY_CONFIG, RESOURCE_CONFIG } from '../config/constants';
import { applyFilterFlag, applySortFlag } from '../middleware/xregistry-flags';
import { parsePaginationParams } from '../utils/request-utils';
import { generateETag } from '../utils/xregistry-utils';
import { ImageService } from './image-service';
import { ContainerRegistryGroup, ImageMetadata, Registry, VersionMetadata } from '../types/xregistry';
import { getSourceApiUrl } from '../utils/image-utils';

export interface RegistryServiceOptions {
    imageService: ImageService;
    logger?: { error(message: string, data?: unknown): void };
}

export class RegistryService {
    private readonly imageService: ImageService;
    private readonly logger: { error(message: string, data?: unknown): void } | undefined;
    private readonly entityState: EntityStateManager;
    private readonly model: unknown;

    constructor(options: RegistryServiceOptions, entityState: EntityStateManager) {
        this.imageService = options.imageService;
        this.logger = options.logger;
        this.entityState = entityState;
        this.model = modelData;
    }

    private getInlineFlags(req: Request): string[] {
        const flags = (req as Request & { xregistryFlags?: { inline?: string[] } }).xregistryFlags;
        return flags?.inline || [];
    }

    private wantsInline(req: Request, attribute: string): boolean {
        const inlineFlags = this.getInlineFlags(req);
        const wantsDoc = Boolean((req as Request & { xregistryFlags?: { doc?: boolean } }).xregistryFlags?.doc);
        return wantsDoc || inlineFlags.includes('*') || inlineFlags.includes(attribute);
    }

    private createPaginationLink(req: Request, offset: number, limit: number, totalCount: number): string | undefined {
        if (offset + limit >= totalCount) {
            return undefined;
        }

        const baseUrl = getBaseUrl(req);
        const nextOffset = offset + limit;
        const query = new URLSearchParams();
        for (const [key, value] of Object.entries(req.query)) {
            if (Array.isArray(value)) {
                value.forEach((item) => query.append(key, String(item)));
            } else if (value !== undefined && value !== null) {
                query.set(key, String(value));
            }
        }
        query.set('offset', String(nextOffset));
        query.set('limit', String(limit));
        return `<${baseUrl}${req.path}?${query.toString()}>; rel="next"`;
    }

    private async buildGroupEntity(req: Request, groupId: string, includeImages: boolean): Promise<ContainerRegistryGroup | null> {
        const backend = this.imageService.getBackend(groupId);
        if (!backend) {
            return null;
        }

        const baseUrl = getBaseUrl(req);
        const groupPath = `/${GROUP_CONFIG.TYPE}/${backend.id}`;
        const imagesCount = await this.imageService.getTotalImageCount(backend.id);
        const group: ContainerRegistryGroup = {
            containerregistryid: backend.id,
            name: backend.name,
            ...(backend.description ? { description: backend.description } : {}),
            sourceurl: getSourceApiUrl(backend.url),
            imagesurl: `${baseUrl}${groupPath}/${RESOURCE_CONFIG.TYPE}`,
            imagescount: imagesCount,
            xid: groupPath,
            self: `${baseUrl}${groupPath}`,
            epoch: this.entityState.getEpoch(groupPath),
            createdat: this.entityState.getCreatedAt(groupPath),
            modifiedat: this.entityState.getModifiedAt(groupPath),
        };

        if (includeImages) {
            const { images } = await this.imageService.getAllImages(backend.id, {}, 0, imagesCount || PAGINATION.DEFAULT_PAGE_LIMIT);
            group.images = this.toImageMap(images);
        }

        return group;
    }

    private toImageMap(images: ImageMetadata[]): Record<string, ImageMetadata> {
        return images.reduce<Record<string, ImageMetadata>>((acc, image) => {
            acc[image.imageid] = image;
            return acc;
        }, {});
    }

    private toVersionMap(versions: VersionMetadata[]): Record<string, VersionMetadata> {
        return versions.reduce<Record<string, VersionMetadata>>((acc, version) => {
            acc[version.versionid] = version;
            return acc;
        }, {});
    }

    private getCapabilitiesObject(): Record<string, unknown> {
        return {
            apis: ['/capabilities', '/model', `/${GROUP_CONFIG.TYPE}`],
            flags: ['collections', 'doc', 'epoch', 'filter', 'inline', 'sort', 'specversion'],
            formats: [REGISTRY_CONFIG.SCHEMA_VERSION],
            mutable: [],
            pagination: true,
            specversions: [REGISTRY_CONFIG.SPEC_VERSION],
        };
    }

    async getRegistry(req: Request, res: Response): Promise<void> {
        try {
            const baseUrl = getBaseUrl(req);
            const registry: Registry = {
                specversion: REGISTRY_CONFIG.SPEC_VERSION,
                registryid: REGISTRY_CONFIG.ID,
                xid: '/',
                self: `${baseUrl}/`,
                epoch: this.entityState.getEpoch('/'),
                createdat: this.entityState.getCreatedAt('/'),
                modifiedat: this.entityState.getModifiedAt('/'),
                name: 'OCI Container Registry Proxy',
                description: 'xRegistry projection of OCI container registries',
                modelurl: `${baseUrl}/model`,
                capabilitiesurl: `${baseUrl}/capabilities`,
                containerregistriesurl: `${baseUrl}/${GROUP_CONFIG.TYPE}`,
                containerregistriescount: this.imageService.getBackends().length,
            };

            if (this.wantsInline(req, 'capabilities')) {
                registry.capabilities = this.getCapabilitiesObject();
            }
            if (this.wantsInline(req, 'model')) {
                registry.model = this.model as Record<string, unknown>;
            }
            if (this.wantsInline(req, GROUP_CONFIG.TYPE)) {
                const groups = await Promise.all(this.imageService.getBackends().map((backend) => this.buildGroupEntity(req, backend.id, false)));
                registry.containerregistries = groups.filter((group): group is ContainerRegistryGroup => group !== null).reduce<Record<string, ContainerRegistryGroup>>((acc, group) => {
                    acc[group.containerregistryid] = group;
                    return acc;
                }, {});
            }

            res.set('ETag', generateETag(registry));
            res.set('Content-Type', 'application/json');
            res.json(registry);
        } catch (error) {
            this.logger?.error('Failed to serve registry root', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    }

    async getGroups(req: Request, res: Response): Promise<void> {
        try {
            const includeImages = this.wantsInline(req, RESOURCE_CONFIG.TYPE);
            const groups = await Promise.all(this.imageService.getBackends().map((backend) => this.buildGroupEntity(req, backend.id, includeImages)));
            const response = groups.filter((group): group is ContainerRegistryGroup => group !== null).reduce<Record<string, ContainerRegistryGroup>>((acc, group) => {
                acc[group.containerregistryid] = group;
                return acc;
            }, {});
            res.set('Content-Type', 'application/json');
            res.json(response);
        } catch (error) {
            this.logger?.error('Failed to get groups', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    }

    async getGroup(req: Request, res: Response): Promise<void> {
        try {
            const groupId = String(req.params['groupId'] || '');
            const group = await this.buildGroupEntity(req, groupId, this.wantsInline(req, RESOURCE_CONFIG.TYPE));
            if (!group) {
                res.status(404).json({ error: 'Group not found' });
                return;
            }
            res.set('Content-Type', 'application/json');
            res.json(group);
        } catch (error) {
            this.logger?.error('Failed to get group', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    }

    async getResources(req: Request, res: Response): Promise<void> {
        try {
            const groupId = String(req.params['groupId'] || '');
            const { offset, limit } = parsePaginationParams(req.query as Record<string, unknown>, PAGINATION.DEFAULT_PAGE_LIMIT);
            const xregistryFlags = (req as Request & { xregistryFlags?: { filter?: string[][]; sort?: { attribute: string; direction: 'asc' | 'desc' } } }).xregistryFlags;
            const wantsFullScan = Boolean(xregistryFlags?.filter) || Boolean(xregistryFlags?.sort);

            const result = wantsFullScan
                ? await this.imageService.getAllImages(groupId, {}, 0, Number.MAX_SAFE_INTEGER)
                : await this.imageService.getAllImages(groupId, {}, offset, limit);

            let images = result.images;
            if (xregistryFlags?.filter) {
                images = applyFilterFlag(images, xregistryFlags.filter) as ImageMetadata[];
            }
            if (xregistryFlags?.sort) {
                images = applySortFlag(images, xregistryFlags.sort) as ImageMetadata[];
            }
            if (wantsFullScan) {
                images = images.slice(offset, offset + limit);
            }

            const linkHeader = this.createPaginationLink(req, offset, limit, wantsFullScan ? result.images.length : result.totalCount);
            if (linkHeader) {
                res.setHeader('Link', linkHeader);
            }

            res.set('Content-Type', 'application/json');
            res.json(this.toImageMap(images));
        } catch (error) {
            this.logger?.error('Failed to get resources', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    }

    async getResource(req: Request, res: Response): Promise<void> {
        try {
            const groupId = String(req.params['groupId'] || '');
            const resourceId = String(req.params['resourceId'] || '');
            const image = await this.imageService.getImage(groupId, resourceId);

            if (this.wantsInline(req, 'meta')) {
                image.meta = await this.imageService.getImageMeta(groupId, resourceId);
            }
            if (this.wantsInline(req, 'versions')) {
                const versionResult = await this.imageService.getImageVersions(groupId, resourceId, 0, Number.MAX_SAFE_INTEGER);
                image.versions = this.toVersionMap(versionResult.versions);
            }

            if ((req as Request & { xregistryFlags?: { collections?: boolean } }).xregistryFlags?.collections) {
                res.json({
                    ...(image.meta ? { meta: image.meta } : {}),
                    ...(image.versions ? { versions: image.versions } : {}),
                });
                return;
            }

            res.set('Content-Type', 'application/json');
            res.json(image);
        } catch (error) {
            this.logger?.error('Failed to get resource', error);
            res.status(404).json({ error: 'Resource not found' });
        }
    }

    async getVersions(req: Request, res: Response): Promise<void> {
        try {
            const groupId = String(req.params['groupId'] || '');
            const resourceId = String(req.params['resourceId'] || '');
            const { offset, limit } = parsePaginationParams(req.query as Record<string, unknown>, PAGINATION.DEFAULT_PAGE_LIMIT);
            const versionResult = await this.imageService.getImageVersions(groupId, resourceId, 0, Number.MAX_SAFE_INTEGER);

            let versions = versionResult.versions;
            const xregistryFlags = (req as Request & { xregistryFlags?: { filter?: string[][]; sort?: { attribute: string; direction: 'asc' | 'desc' } } }).xregistryFlags;
            if (xregistryFlags?.filter) {
                versions = applyFilterFlag(versions, xregistryFlags.filter) as VersionMetadata[];
            }
            if (xregistryFlags?.sort) {
                versions = applySortFlag(versions, xregistryFlags.sort) as VersionMetadata[];
            }

            const pagedVersions = versions.slice(offset, offset + limit);
            const linkHeader = this.createPaginationLink(req, offset, limit, versions.length);
            if (linkHeader) {
                res.setHeader('Link', linkHeader);
            }

            res.set('Content-Type', 'application/json');
            res.json(this.toVersionMap(pagedVersions));
        } catch (error) {
            this.logger?.error('Failed to get versions', error);
            res.status(404).json({ error: 'Versions not found' });
        }
    }

    async getVersion(req: Request, res: Response): Promise<void> {
        try {
            const groupId = String(req.params['groupId'] || '');
            const resourceId = String(req.params['resourceId'] || '');
            const versionId = String(req.params['versionId'] || '');
            const version = await this.imageService.getImageVersion(groupId, resourceId, versionId);
            res.set('Content-Type', 'application/json');
            res.json(version);
        } catch (error) {
            this.logger?.error('Failed to get version', error);
            res.status(404).json({ error: 'Version not found' });
        }
    }

    async getMeta(req: Request, res: Response): Promise<void> {
        try {
            const groupId = String(req.params['groupId'] || '');
            const resourceId = String(req.params['resourceId'] || '');
            const meta = await this.imageService.getImageMeta(groupId, resourceId);
            res.set('Content-Type', 'application/json');
            res.json(meta);
        } catch (error) {
            this.logger?.error('Failed to get meta', error);
            res.status(404).json({ error: 'Meta not found' });
        }
    }

    async getCapabilities(_req: Request, res: Response): Promise<void> {
        res.json(this.getCapabilitiesObject());
    }

    async getModel(_req: Request, res: Response): Promise<void> {
        res.json(this.model);
    }
}
