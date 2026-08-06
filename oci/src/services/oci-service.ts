import axios, { AxiosInstance, AxiosResponse } from 'axios';
import * as fs from 'fs';
import { EntityStateManager } from '../../../shared/entity-state-manager';
import { CACHE_CONFIG, OCI_REGISTRY } from '../config/constants';
import {
    DockerAuthTokenResponse,
    OCIBackend,
    OCICatalogResponse,
    OCIDescriptor,
    OCIImageConfig,
    OCIManifest,
    OCITagsResponse,
} from '../types/oci';
import {
    BuildHistoryEntry,
    DescriptorInfo,
    ImageMeta,
    ImageMetadata,
    OciLabelProjection,
    OciVersionDetails,
    PlatformInfo,
    ReferrerInfo,
    VersionMetadata,
} from '../types/xregistry';
import { canonicalizeRegistryId, getNamespaceFromRepository, getSourceApiUrl, matchesImageId, repositoryNameFromImageId, toImageId } from '../utils/image-utils';
import { normalizeTimestamp } from '../utils/xregistry-utils';

const MANIFEST_ACCEPT = [
    'application/vnd.oci.image.index.v1+json',
    'application/vnd.oci.image.manifest.v1+json',
    'application/vnd.docker.distribution.manifest.list.v2+json',
    'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

interface OCIRequestResult<T> {
    status: number;
    body: T;
    headers: Record<string, string | string[] | undefined>;
}

interface OCIManifestResult {
    manifest: OCIManifest;
    digest?: string;
}

interface ManifestProjection {
    createdHint?: string;
    description?: string;
    annotations?: Record<string, string>;
    config_labels?: Record<string, string>;
    layers?: Array<{ digest: string; size?: number; mediatype?: string }>;
    build_history?: BuildHistoryEntry[];
    urls?: {
        pull?: string;
        manifest?: string;
        config?: string;
    };
    referrers?: ReferrerInfo[];
    metadata: OciVersionDetails;
}

export interface OCIServiceConfig {
    backends?: OCIBackend[];
    timeout?: number;
    userAgent?: string;
    cacheDir?: string;
    baseUrl?: string;
    entityState?: EntityStateManager;
}

export class OCIService {
    private readonly httpClient: AxiosInstance;
    private readonly cacheDir: string;
    private readonly backends: OCIBackend[];
    private readonly authTokens = new Map<string, { token: string; expires: number }>();
    private readonly baseUrl: string;
    private readonly entityState: EntityStateManager;

    constructor(config: OCIServiceConfig = {}) {
        this.baseUrl = config.baseUrl || 'http://localhost:3400';
        this.entityState = config.entityState || new EntityStateManager();
        this.backends = (config.backends || [{
            id: 'mcr.microsoft.com',
            name: 'Microsoft Container Registry',
            url: 'https://mcr.microsoft.com',
            apiVersion: 'v2',
            description: 'Microsoft Container Registry',
            enabled: true,
            public: true,
            catalogPath: '/v2/_catalog',
        }]).map((backend) => ({
            ...backend,
            id: canonicalizeRegistryId(backend.id),
        }));
        this.cacheDir = config.cacheDir || CACHE_CONFIG.CACHE_DIR;
        this.httpClient = axios.create({
            timeout: config.timeout || OCI_REGISTRY.TIMEOUT_MS,
            headers: {
                'User-Agent': config.userAgent || OCI_REGISTRY.USER_AGENT,
            },
        });

        if (!fs.existsSync(this.cacheDir)) {
            fs.mkdirSync(this.cacheDir, { recursive: true });
        }
    }

    private buildEntityCommon(path: string, createdHint?: string): Pick<ImageMetadata, 'xid' | 'self' | 'epoch' | 'createdat' | 'modifiedat'> {
        const normalizedCreated = normalizeTimestamp(createdHint);
        return {
            xid: path,
            self: `${this.baseUrl}${path}`,
            epoch: this.entityState.getEpoch(path),
            createdat: normalizedCreated || this.entityState.getCreatedAt(path),
            modifiedat: this.entityState.getModifiedAt(path),
        };
    }

    private getDefaultTag(tags: string[]): string | undefined {
        if (tags.includes('latest')) {
            return 'latest';
        }
        return tags[0];
    }

    private async getAuthToken(backend: OCIBackend, repository: string): Promise<string | null> {
        const cacheKey = `${backend.id}:${repository}`;
        const cached = this.authTokens.get(cacheKey);
        if (cached && cached.expires > Date.now()) {
            return cached.token;
        }

        if (backend.id !== 'docker.io') {
            return backend.token || null;
        }

        try {
            const authBaseUrl = (backend.authUrl || OCI_REGISTRY.AUTH_URL).replace(/\/+$/, '');
            const authUrl = `${authBaseUrl}/token?service=registry.docker.io&scope=repository:${repository}:pull`;
            const authConfig = backend.username && (backend.password || backend.token)
                ? {
                    auth: {
                        username: backend.username,
                        password: backend.password || backend.token || '',
                    },
                }
                : undefined;
            const response = await axios.get<DockerAuthTokenResponse>(authUrl, authConfig);
            const token = response.data.token || response.data.access_token;
            if (!token) {
                return null;
            }

            const expiresIn = response.data.expires_in || 300;
            this.authTokens.set(cacheKey, {
                token,
                expires: Date.now() + (expiresIn * 1000),
            });
            return token;
        } catch {
            return null;
        }
    }

    private async buildRequestHeaders(backend: OCIBackend, repository?: string, accept?: string): Promise<Record<string, string>> {
        const headers: Record<string, string> = {
            'User-Agent': OCI_REGISTRY.USER_AGENT,
        };

        if (accept) {
            headers['Accept'] = accept;
        }

        if (repository) {
            const token = await this.getAuthToken(backend, repository);
            if (token) {
                headers['Authorization'] = `Bearer ${token}`;
                return headers;
            }
        }

        if (backend.username && backend.password) {
            const basicToken = Buffer.from(`${backend.username}:${backend.password}`, 'utf8').toString('base64');
            headers['Authorization'] = `Basic ${basicToken}`;
        } else if (backend.token) {
            headers['Authorization'] = `Bearer ${backend.token}`;
        }

        return headers;
    }

    private async ociRequest<T>(
        backend: OCIBackend,
        path: string,
        options: {
            repository?: string;
            accept?: string;
            allowStatuses?: number[];
        } = {}
    ): Promise<OCIRequestResult<T>> {
        const isAbsoluteUrl = /^https?:\/\//i.test(path);
        const url = isAbsoluteUrl ? path : `${backend.url}${path}`;
        const headers = await this.buildRequestHeaders(backend, options.repository, options.accept);
        const response: AxiosResponse<T> = await this.httpClient.get<T>(url, {
            headers,
            validateStatus: () => true,
        });

        if (response.status >= 400 && !(options.allowStatuses || []).includes(response.status)) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        return {
            status: response.status,
            body: response.data,
            headers: response.headers as Record<string, string | string[] | undefined>,
        };
    }

    private getNextLink(linkHeader: string | string[] | undefined, backend: OCIBackend): string | undefined {
        const headerValue = Array.isArray(linkHeader) ? linkHeader.join(',') : linkHeader;
        if (!headerValue) {
            return undefined;
        }

        const nextLink = headerValue.split(',').find((link) => link.includes('rel="next"'));
        if (!nextLink) {
            return undefined;
        }

        const match = nextLink.match(/<([^>]+)>/);
        if (!match || !match[1]) {
            return undefined;
        }

        const nextUrl = new URL(match[1], backend.url);
        return `${nextUrl.pathname}${nextUrl.search}`;
    }

    private isManifestList(manifest: OCIManifest): boolean {
        return manifest.mediaType === 'application/vnd.docker.distribution.manifest.list.v2+json'
            || manifest.mediaType === 'application/vnd.oci.image.index.v1+json';
    }

    private mapDescriptor(descriptor?: OCIDescriptor): DescriptorInfo | undefined {
        if (!descriptor) {
            return undefined;
        }

        return {
            digest: descriptor.digest,
            ...(descriptor.mediaType ? { mediatype: descriptor.mediaType } : {}),
            ...(descriptor.size !== undefined ? { size: descriptor.size } : {}),
        };
    }

    private mapReferrer(descriptor: OCIDescriptor): ReferrerInfo {
        return {
            digest: descriptor.digest,
            ...(descriptor.mediaType ? { mediatype: descriptor.mediaType } : {}),
            ...(descriptor.size !== undefined ? { size: descriptor.size } : {}),
            ...(descriptor.artifactType ? { artifact_type: descriptor.artifactType } : {}),
            ...(descriptor.annotations ? { annotations: descriptor.annotations } : {}),
        };
    }

    private mapAvailablePlatforms(manifests: OCIDescriptor[]): PlatformInfo[] {
        return manifests
            .filter((manifest) => manifest.platform?.architecture && manifest.platform?.os)
            .map((manifest) => ({
                architecture: manifest.platform?.architecture || 'unknown',
                os: manifest.platform?.os || 'unknown',
                ...(manifest.platform?.variant ? { variant: manifest.platform.variant } : {}),
                digest: manifest.digest,
                ...(manifest.size !== undefined ? { size: manifest.size } : {}),
                ...(manifest.mediaType ? { mediatype: manifest.mediaType } : {}),
            }));
    }

    private mapOciLabels(annotations?: Record<string, string>): OciLabelProjection | undefined {
        if (!annotations) {
            return undefined;
        }

        const labelProjection: OciLabelProjection = {
            ...(annotations['org.opencontainers.image.title'] ? { title: annotations['org.opencontainers.image.title'] } : {}),
            ...(annotations['org.opencontainers.image.description'] ? { description: annotations['org.opencontainers.image.description'] } : {}),
            ...(annotations['org.opencontainers.image.version'] ? { version: annotations['org.opencontainers.image.version'] } : {}),
            ...(annotations['org.opencontainers.image.created'] ? { created: annotations['org.opencontainers.image.created'] } : {}),
            ...(annotations['org.opencontainers.image.revision'] ? { revision: annotations['org.opencontainers.image.revision'] } : {}),
            ...(annotations['org.opencontainers.image.source'] ? { source: annotations['org.opencontainers.image.source'] } : {}),
            ...(annotations['org.opencontainers.image.url'] ? { url: annotations['org.opencontainers.image.url'] } : {}),
            ...(annotations['org.opencontainers.image.documentation'] ? { documentation: annotations['org.opencontainers.image.documentation'] } : {}),
            ...(annotations['org.opencontainers.image.licenses'] ? { licenses: annotations['org.opencontainers.image.licenses'] } : {}),
            ...(annotations['org.opencontainers.image.vendor'] ? { vendor: annotations['org.opencontainers.image.vendor'] } : {}),
            ...(annotations['org.opencontainers.image.authors'] ? { authors: annotations['org.opencontainers.image.authors'] } : {}),
            ...(annotations['org.opencontainers.image.ref.name'] ? { ref_name: annotations['org.opencontainers.image.ref.name'] } : {}),
            ...(annotations['org.opencontainers.image.base.digest'] ? { base_digest: annotations['org.opencontainers.image.base.digest'] } : {}),
            ...(annotations['org.opencontainers.image.base.name'] ? { base_name: annotations['org.opencontainers.image.base.name'] } : {}),
        };

        return Object.keys(labelProjection).length > 0 ? labelProjection : undefined;
    }

    private async getManifestResponse(backend: OCIBackend, repository: string, reference: string): Promise<OCIManifestResult | null> {
        try {
            const response = await this.ociRequest<OCIManifest>(
                backend,
                `/v2/${repository}/manifests/${reference}`,
                {
                    repository,
                    accept: MANIFEST_ACCEPT,
                }
            );

            const digestHeader = response.headers['docker-content-digest'];
            const digest = Array.isArray(digestHeader) ? digestHeader[0] : digestHeader;
            return {
                manifest: response.body,
                ...(digest ? { digest } : {}),
            };
        } catch {
            return null;
        }
    }

    async getManifest(backend: OCIBackend, repository: string, reference: string): Promise<OCIManifest | null> {
        const manifestResult = await this.getManifestResponse(backend, repository, reference);
        return manifestResult?.manifest || null;
    }

    async getImageConfig(backend: OCIBackend, repository: string, configDigest: string): Promise<OCIImageConfig | null> {
        try {
            const response = await this.ociRequest<OCIImageConfig>(backend, `/v2/${repository}/blobs/${configDigest}`, { repository });
            return response.body;
        } catch {
            return null;
        }
    }

    private async getReferrers(backend: OCIBackend, repository: string, digest: string): Promise<ReferrerInfo[] | undefined> {
        let nextPath: string | undefined = `/v2/${repository}/referrers/${digest}`;
        const referrers: ReferrerInfo[] = [];
        let sawSuccessfulResponse = false;

        while (nextPath) {
            const response = await this.ociRequest<OCIManifest>(backend, nextPath, {
                repository,
                accept: 'application/vnd.oci.image.index.v1+json',
                allowStatuses: [404],
            });

            if (response.status === 404) {
                return undefined;
            }

            sawSuccessfulResponse = true;
            referrers.push(...(response.body.manifests || []).map((manifest) => this.mapReferrer(manifest)));
            nextPath = this.getNextLink(response.headers['link'], backend);
        }

        if (!sawSuccessfulResponse) {
            return undefined;
        }

        return referrers;
    }

    private async buildManifestProjection(backend: OCIBackend, repository: string, reference: string): Promise<ManifestProjection | null> {
        const originalManifestResult = await this.getManifestResponse(backend, repository, reference);
        if (!originalManifestResult) {
            return null;
        }

        const originalManifest = originalManifestResult.manifest;
        const multiPlatform = this.isManifestList(originalManifest);
        let selectedManifest = originalManifest;

        if (multiPlatform && originalManifest.manifests && originalManifest.manifests.length > 0) {
            const preferredManifest = originalManifest.manifests.find((manifest) =>
                manifest.platform?.architecture === 'amd64' && manifest.platform?.os === 'linux'
            ) || originalManifest.manifests[0];

            if (preferredManifest) {
                const preferredManifestResult = await this.getManifestResponse(backend, repository, preferredManifest.digest);
                if (preferredManifestResult) {
                    selectedManifest = preferredManifestResult.manifest;
                }
            }
        }

        const configDescriptor = selectedManifest.config;
        const imageConfig = configDescriptor ? await this.getImageConfig(backend, repository, configDescriptor.digest) : null;
        const annotations = originalManifest.annotations;
        const configLabels = imageConfig?.config?.Labels;
        const availablePlatforms = multiPlatform && originalManifest.manifests
            ? this.mapAvailablePlatforms(originalManifest.manifests)
            : undefined;

        const sizeBytes = selectedManifest.layers
            ? selectedManifest.layers.reduce((sum, layer) => sum + (layer.size || 0), 0)
            : undefined;
        const manifestDigest = originalManifestResult.digest || (reference.startsWith('sha256:') ? reference : undefined);
        const referrers = manifestDigest ? await this.getReferrers(backend, repository, manifestDigest) : undefined;
        const subject = this.mapDescriptor(originalManifest.subject);
        const config = this.mapDescriptor(configDescriptor);
        const ociLabels = this.mapOciLabels(annotations);

        const metadata: OciVersionDetails = {
            ...(manifestDigest ? { digest: manifestDigest } : {}),
            ...(originalManifest.mediaType ? { manifest_mediatype: originalManifest.mediaType } : {}),
            ...(originalManifest.artifactType ? { artifact_type: originalManifest.artifactType } : {}),
            ...(subject ? { subject } : {}),
            ...(config ? { config } : {}),
            ...(originalManifest.schemaVersion !== undefined ? { schema_version: originalManifest.schemaVersion } : {}),
            ...(selectedManifest.layers ? { layers_count: selectedManifest.layers.length } : {}),
            ...(sizeBytes !== undefined ? { size_bytes: sizeBytes } : {}),
            ...(multiPlatform ? { is_multi_platform: true } : {}),
            ...(!multiPlatform && imageConfig?.architecture ? { architecture: imageConfig.architecture } : {}),
            ...(!multiPlatform && imageConfig?.os ? { os: imageConfig.os } : {}),
            ...(!multiPlatform && imageConfig?.variant ? { variant: imageConfig.variant } : {}),
            ...(!multiPlatform && imageConfig?.['os.version'] ? { os_version: imageConfig['os.version'] } : {}),
            ...(!multiPlatform && imageConfig?.['os.features'] ? { os_features: imageConfig['os.features'] } : {}),
            ...(availablePlatforms && availablePlatforms.length > 0 ? { available_platforms: availablePlatforms } : {}),
            ...(ociLabels ? { oci_labels: ociLabels } : {}),
            ...(imageConfig?.config?.Env ? { environment: imageConfig.config.Env } : {}),
            ...(imageConfig?.config?.WorkingDir ? { working_dir: imageConfig.config.WorkingDir } : {}),
            ...(imageConfig?.config?.Entrypoint ? { entrypoint: imageConfig.config.Entrypoint } : {}),
            ...(imageConfig?.config?.Cmd ? { cmd: imageConfig.config.Cmd } : {}),
            ...(imageConfig?.config?.User ? { user: imageConfig.config.User } : {}),
            ...(imageConfig?.config?.StopSignal ? { stop_signal: imageConfig.config.StopSignal } : {}),
            ...(imageConfig?.author ? { author: imageConfig.author } : {}),
            ...(imageConfig?.rootfs?.diff_ids ? { rootfs_diff_ids: imageConfig.rootfs.diff_ids } : {}),
            ...(imageConfig?.config?.ExposedPorts ? { exposed_ports: Object.keys(imageConfig.config.ExposedPorts) } : {}),
            ...(imageConfig?.config?.Volumes ? { volumes: Object.keys(imageConfig.config.Volumes) } : {}),
        };

        const buildHistory = imageConfig?.history?.map<BuildHistoryEntry>((entry, index) => ({
            step: index + 1,
            ...(entry.created ? { created: entry.created } : {}),
            ...(entry.created_by ? { created_by: entry.created_by } : {}),
            ...(entry.empty_layer !== undefined ? { empty_layer: entry.empty_layer } : {}),
            ...(entry.author ? { author: entry.author } : {}),
            ...(entry.comment ? { comment: entry.comment } : {}),
        }));

        return {
            ...(imageConfig?.created ? { createdHint: imageConfig.created } : {}),
            ...(metadata.oci_labels?.description ? { description: metadata.oci_labels.description } : {}),
            ...(annotations ? { annotations } : {}),
            ...(configLabels ? { config_labels: configLabels } : {}),
            ...(selectedManifest.layers ? {
                layers: selectedManifest.layers.map((layer) => ({
                    digest: layer.digest,
                    ...(layer.size !== undefined ? { size: layer.size } : {}),
                    ...(layer.mediaType ? { mediatype: layer.mediaType } : {}),
                })),
            } : {}),
            ...(buildHistory && buildHistory.length > 0 ? { build_history: buildHistory } : {}),
            urls: {
                pull: `${backend.url.replace(/\/+$/, '')}/${repository}:${reference}`,
                manifest: `${backend.url.replace(/\/+$/, '')}/v2/${repository}/manifests/${reference}`,
                ...(configDescriptor?.digest ? { config: `${backend.url.replace(/\/+$/, '')}/v2/${repository}/blobs/${configDescriptor.digest}` } : {}),
            },
            ...(referrers !== undefined ? { referrers } : {}),
            metadata,
        };
    }

    async listRepositories(backend: OCIBackend): Promise<string[]> {
        const catalogPath = backend.catalogPath || '/v2/_catalog';
        if (catalogPath === 'disabled') {
            return [];
        }

        try {
            const repositories: string[] = [];
            let nextPath: string | undefined = `${catalogPath}${catalogPath.includes('?') ? '&' : '?'}n=1000`;

            while (nextPath) {
                const response = await this.ociRequest<OCICatalogResponse>(backend, nextPath);
                repositories.push(...(response.body.repositories || []));
                nextPath = this.getNextLink(response.headers['link'], backend);
            }

            return repositories;
        } catch {
            return [];
        }
    }

    async resolveRepository(backend: OCIBackend, imageIdOrRepository: string): Promise<string | null> {
        if (!imageIdOrRepository) {
            return null;
        }

        if (imageIdOrRepository.includes('/')) {
            return imageIdOrRepository;
        }

        const reversibleRepository = repositoryNameFromImageId(imageIdOrRepository);
        if (reversibleRepository) {
            return reversibleRepository;
        }

        const repositories = await this.listRepositories(backend);
        return repositories.find((repository) => matchesImageId(repository, imageIdOrRepository)) || null;
    }

    async listTags(backend: OCIBackend, repository: string): Promise<string[]> {
        try {
            const tags: string[] = [];
            let nextPath: string | undefined = `/v2/${repository}/tags/list?n=1000`;

            while (nextPath) {
                const response = await this.ociRequest<OCITagsResponse>(backend, nextPath, { repository });
                tags.push(...(response.body.tags || []));
                nextPath = this.getNextLink(response.headers['link'], backend);
            }

            return tags;
        } catch {
            return [];
        }
    }

    async getImageMetadata(backend: OCIBackend, repository: string): Promise<ImageMetadata | null> {
        const tags = await this.listTags(backend, repository);
        const defaultTag = this.getDefaultTag(tags);
        if (!defaultTag) {
            return null;
        }

        const projection = await this.buildManifestProjection(backend, repository, defaultTag);
        if (!projection) {
            return null;
        }

        const imageId = toImageId(repository);
        const resourcePath = `/containerregistries/${backend.id}/images/${imageId}`;
        const meta = await this.getImageMeta(backend, repository, defaultTag);

        return {
            imageid: imageId,
            versionid: defaultTag,
            isdefault: true,
            name: repository,
            ...(projection.description ? { description: projection.description } : {}),
            versionsurl: `${this.baseUrl}${resourcePath}/versions`,
            versionscount: tags.length,
            metaurl: `${this.baseUrl}${resourcePath}/meta`,
            ...(meta ? { meta } : {}),
            ...this.buildEntityCommon(resourcePath, projection.createdHint),
            ...(projection.annotations ? { annotations: projection.annotations } : {}),
            ...(projection.config_labels ? { config_labels: projection.config_labels } : {}),
            ...(projection.layers ? { layers: projection.layers } : {}),
            ...(projection.build_history ? { build_history: projection.build_history } : {}),
            ...(projection.urls ? { urls: projection.urls } : {}),
            ...(projection.referrers !== undefined ? { referrers: projection.referrers } : {}),
            metadata: projection.metadata,
        };
    }

    async convertToVersionMetadata(
        backend: OCIBackend,
        repository: string,
        tag: string,
        defaultTag?: string
    ): Promise<VersionMetadata | null> {
        const projection = await this.buildManifestProjection(backend, repository, tag);
        if (!projection) {
            return null;
        }

        const imageId = toImageId(repository);
        const versionPath = `/containerregistries/${backend.id}/images/${imageId}/versions/${tag}`;
        return {
            versionid: tag,
            isdefault: tag === defaultTag,
            name: tag,
            ...(projection.description ? { description: projection.description } : {}),
            ...this.buildEntityCommon(versionPath, projection.createdHint),
            ...(projection.annotations ? { annotations: projection.annotations } : {}),
            ...(projection.config_labels ? { config_labels: projection.config_labels } : {}),
            ...(projection.layers ? { layers: projection.layers } : {}),
            ...(projection.build_history ? { build_history: projection.build_history } : {}),
            ...(projection.urls ? { urls: projection.urls } : {}),
            ...(projection.referrers !== undefined ? { referrers: projection.referrers } : {}),
            metadata: projection.metadata,
        };
    }

    async getVersionMetadata(backend: OCIBackend, repository: string, tag: string, defaultTag?: string): Promise<VersionMetadata | null> {
        return this.convertToVersionMetadata(backend, repository, tag, defaultTag);
    }

    async imageExists(backend: OCIBackend, repository: string): Promise<boolean> {
        const tags = await this.listTags(backend, repository);
        return tags.length > 0;
    }

    async getImageMeta(backend: OCIBackend, repository: string, defaultTag?: string): Promise<ImageMeta | null> {
        const tags = defaultTag ? [] : await this.listTags(backend, repository);
        const resolvedDefaultTag = defaultTag || this.getDefaultTag(tags);
        if (!resolvedDefaultTag) {
            return null;
        }

        const imageId = toImageId(repository);
        const metaPath = `/containerregistries/${backend.id}/images/${imageId}/meta`;
        const namespace = getNamespaceFromRepository(repository);

        return {
            ...this.buildEntityCommon(metaPath),
            readonly: true,
            defaultversionid: resolvedDefaultTag,
            defaultversionurl: `${this.baseUrl}/containerregistries/${backend.id}/images/${imageId}/versions/${resolvedDefaultTag}`,
            defaultversionsticky: true,
            sourceurl: getSourceApiUrl(backend.url),
            ...(namespace ? { namespace } : {}),
            repository,
        };
    }

    async tagExists(backend: OCIBackend, repository: string, tag: string): Promise<boolean> {
        const manifest = await this.getManifest(backend, repository, tag);
        return manifest !== null;
    }

    getBackends(): OCIBackend[] {
        return this.backends.filter((backend) => backend.enabled);
    }

    getBackend(id: string): OCIBackend | undefined {
        return this.backends.find((backend) => backend.id === canonicalizeRegistryId(id) && backend.enabled);
    }

    async getImages(
        backend: OCIBackend,
        options: { limit?: number; offset?: number; query?: string } = {}
    ): Promise<{ images: string[]; total: number }> {
        const allRepositories = await this.listRepositories(backend);
        const filteredRepositories = options.query
            ? allRepositories.filter((repository) => repository.toLowerCase().includes(options.query!.toLowerCase()))
            : allRepositories;

        const offset = options.offset || 0;
        const limit = options.limit || 50;
        return {
            images: filteredRepositories.slice(offset, offset + limit),
            total: filteredRepositories.length,
        };
    }

    async getTotalImageCount(backend: OCIBackend): Promise<number> {
        const repositories = await this.listRepositories(backend);
        return repositories.length;
    }
}
