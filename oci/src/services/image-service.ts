import { OCIBackend } from '../types/oci';
import { ImageMeta, ImageMetadata, VersionMetadata } from '../types/xregistry';
import { EntityStateManager } from '../../../shared/entity-state-manager';
import { toImageId } from '../utils/image-utils';
import { OCIService } from './oci-service';

export interface ImageServiceOptions {
    ociService: OCIService;
    baseUrl?: string;
}

export class ImageService {
    private readonly ociService: OCIService;
    private readonly baseUrl: string;
    private readonly entityState: EntityStateManager;

    constructor(options: ImageServiceOptions, entityState: EntityStateManager) {
        this.ociService = options.ociService;
        this.baseUrl = options.baseUrl || 'http://localhost:3400';
        this.entityState = entityState;
    }

    getBackends(): OCIBackend[] {
        return this.ociService.getBackends();
    }

    getBackend(backendId: string): OCIBackend | undefined {
        return this.ociService.getBackend(backendId);
    }

    private async resolveBackendAndRepository(backendId: string, imageId: string): Promise<{ backend: OCIBackend; repository: string } | null> {
        const backend = this.ociService.getBackend(backendId);
        if (!backend) {
            return null;
        }

        const repository = await this.ociService.resolveRepository(backend, imageId);
        if (!repository) {
            return null;
        }

        return { backend, repository };
    }

    async getAllImages(
        backendId: string,
        filters: Record<string, string> = {},
        offset: number = 0,
        limit: number = 50
    ): Promise<{ images: ImageMetadata[]; totalCount: number }> {
        const backend = this.ociService.getBackend(backendId);
        if (!backend) {
            return { images: [], totalCount: 0 };
        }

        const query = Object.keys(filters).length > 0 ? Object.values(filters).join(' ') : undefined;
        const result = await this.ociService.getImages(backend, { offset, limit, ...(query ? { query } : {}) });
        const images = await Promise.all(result.images.map(async (repository) => {
            return (await this.ociService.getImageMetadata(backend, repository)) || this.createBasicImageMetadata(backend, repository);
        }));

        return {
            images,
            totalCount: result.total,
        };
    }

    async getImage(backendId: string, imageId: string): Promise<ImageMetadata> {
        const resolved = await this.resolveBackendAndRepository(backendId, imageId);
        if (!resolved) {
            throw new Error(`Image '${imageId}' not found in backend '${backendId}'`);
        }

        const metadata = await this.ociService.getImageMetadata(resolved.backend, resolved.repository);
        if (!metadata) {
            throw new Error(`Image '${imageId}' not found in backend '${backendId}'`);
        }

        return metadata;
    }

    async getImageVersions(
        backendId: string,
        imageId: string,
        offset: number = 0,
        limit: number = 50
    ): Promise<{ versions: VersionMetadata[]; totalCount: number }> {
        const resolved = await this.resolveBackendAndRepository(backendId, imageId);
        if (!resolved) {
            throw new Error(`Image '${imageId}' not found in backend '${backendId}'`);
        }

        const tags = await this.ociService.listTags(resolved.backend, resolved.repository);
        if (tags.length === 0) {
            throw new Error(`Image '${imageId}' not found in backend '${backendId}'`);
        }

        const defaultTag = tags.includes('latest') ? 'latest' : tags[0];
        const selectedTags = tags.slice(offset, offset + limit);
        const versions = await Promise.all(selectedTags.map(async (tag) => {
            return (await this.ociService.getVersionMetadata(resolved.backend, resolved.repository, tag, defaultTag))
                || this.createBasicVersionMetadata(resolved.backend, resolved.repository, tag, defaultTag);
        }));

        return {
            versions,
            totalCount: tags.length,
        };
    }

    async getImageVersion(backendId: string, imageId: string, tag: string): Promise<VersionMetadata> {
        const resolved = await this.resolveBackendAndRepository(backendId, imageId);
        if (!resolved) {
            throw new Error(`Image '${imageId}' not found in backend '${backendId}'`);
        }

        const tags = await this.ociService.listTags(resolved.backend, resolved.repository);
        if (!tags.includes(tag)) {
            throw new Error(`Tag '${tag}' not found for image '${imageId}' in backend '${backendId}'`);
        }

        const defaultTag = tags.includes('latest') ? 'latest' : tags[0];
        const metadata = await this.ociService.getVersionMetadata(resolved.backend, resolved.repository, tag, defaultTag);
        if (!metadata) {
            throw new Error(`Tag '${tag}' not found for image '${imageId}' in backend '${backendId}'`);
        }

        return metadata;
    }

    async getImageMeta(backendId: string, imageId: string): Promise<ImageMeta> {
        const resolved = await this.resolveBackendAndRepository(backendId, imageId);
        if (!resolved) {
            throw new Error(`Meta for image '${imageId}' not found in backend '${backendId}'`);
        }

        const meta = await this.ociService.getImageMeta(resolved.backend, resolved.repository);
        if (!meta) {
            throw new Error(`Meta for image '${imageId}' not found in backend '${backendId}'`);
        }

        return meta;
    }

    async imageExists(backendId: string, imageId: string): Promise<boolean> {
        const resolved = await this.resolveBackendAndRepository(backendId, imageId);
        if (!resolved) {
            return false;
        }
        return this.ociService.imageExists(resolved.backend, resolved.repository);
    }

    async versionExists(backendId: string, imageId: string, tag: string): Promise<boolean> {
        const resolved = await this.resolveBackendAndRepository(backendId, imageId);
        if (!resolved) {
            return false;
        }
        return this.ociService.tagExists(resolved.backend, resolved.repository, tag);
    }

    async getTotalImageCount(backendId: string): Promise<number> {
        const backend = this.ociService.getBackend(backendId);
        if (!backend) {
            return 0;
        }
        return this.ociService.getTotalImageCount(backend);
    }

    private createBasicImageMetadata(backend: OCIBackend, repository: string): ImageMetadata {
        const imageId = toImageId(repository);
        const resourcePath = `/containerregistries/${backend.id}/images/${imageId}`;
        return {
            imageid: imageId,
            versionid: 'latest',
            isdefault: true,
            name: repository,
            versionsurl: `${this.baseUrl}${resourcePath}/versions`,
            versionscount: 0,
            metaurl: `${this.baseUrl}${resourcePath}/meta`,
            meta: {
                xid: `${resourcePath}/meta`,
                self: `${this.baseUrl}${resourcePath}/meta`,
                epoch: this.entityState.getEpoch(`${resourcePath}/meta`),
                createdat: this.entityState.getCreatedAt(`${resourcePath}/meta`),
                modifiedat: this.entityState.getModifiedAt(`${resourcePath}/meta`),
                readonly: true,
                sourceurl: `${backend.url.replace(/\/+$/, '')}/v2/`,
                repository,
            },
            xid: resourcePath,
            self: `${this.baseUrl}${resourcePath}`,
            epoch: this.entityState.getEpoch(resourcePath),
            createdat: this.entityState.getCreatedAt(resourcePath),
            modifiedat: this.entityState.getModifiedAt(resourcePath),
        };
    }

    private createBasicVersionMetadata(backend: OCIBackend, repository: string, tag: string, defaultTag?: string): VersionMetadata {
        const imageId = toImageId(repository);
        const versionPath = `/containerregistries/${backend.id}/images/${imageId}/versions/${tag}`;
        return {
            versionid: tag,
            isdefault: tag === defaultTag,
            name: tag,
            xid: versionPath,
            self: `${this.baseUrl}${versionPath}`,
            epoch: this.entityState.getEpoch(versionPath),
            createdat: this.entityState.getCreatedAt(versionPath),
            modifiedat: this.entityState.getModifiedAt(versionPath),
        };
    }
}
