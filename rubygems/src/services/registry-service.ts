import { Request, Response } from 'express';
import modelData from '../../model.json';
import { CACHE_CONFIG, getBaseUrl, GROUP_CONFIG, REGISTRY_CONFIG, RESOURCE_CONFIG } from '../config/constants';
import { throwEntityNotFound, throwInvalidData, throwServiceUnavailable, isProblemDetailsError } from '../middleware/xregistry-error-handler';
import { includesInline, parseRequestFlags, XRegistryRequestFlags } from '../middleware/xregistry-flags';
import { RubyGemDependencies, RubyGemMetadata, RubyGemVersion, XRegistryPackage, XRegistryVersion } from '../types/xregistry';
import { buildGemUri, buildVersionId, encodeGemName, parseVersionId } from '../utils/package-utils';
import { RubyGemsService } from './rubygems-service';

const DEFAULT_PACKAGE_NAMES = [
    'bundler',
    'rake',
    'rack',
    'rails',
    'sinatra',
    'nokogiri',
    'rspec',
    'rubocop',
    'devise',
    'sidekiq',
    'pg',
    'puma',
    'ffi',
    'thor',
    'pry',
    'faraday',
    'sass',
    'tzinfo',
    'concurrent-ruby',
    'bootsnap',
] as const;

export class RegistryService {
    private readonly serviceCreatedAt = new Date().toISOString();

    constructor(private readonly rubygemsService: RubyGemsService) {}

    async getRegistry(req: Request, res: Response): Promise<void> {
        const baseUrl = getBaseUrl(req);
        res.json({
            specversion: REGISTRY_CONFIG.SPEC_VERSION,
            registryid: REGISTRY_CONFIG.ID,
            xid: '/',
            self: `${baseUrl}/`,
            epoch: 1,
            createdat: this.serviceCreatedAt,
            modifiedat: this.serviceCreatedAt,
            description: 'xRegistry proxy for the public RubyGems registry.',
            model: `${baseUrl}/model`,
            [`${GROUP_CONFIG.TYPE}url`]: `${baseUrl}/${GROUP_CONFIG.TYPE}`,
            [`${GROUP_CONFIG.TYPE}count`]: 1,
        });
    }

    async getModel(req: Request, res: Response): Promise<void> {
        const baseUrl = getBaseUrl(req);
        const payload = JSON.parse(JSON.stringify(modelData)) as Record<string, unknown>;
        payload['self'] = `${baseUrl}/model`;
        res.json(payload);
    }

    async getGroups(req: Request, res: Response): Promise<void> {
        const baseUrl = getBaseUrl(req);
        res.json({
            [GROUP_CONFIG.ID]: this.buildGroupEntity(baseUrl),
        });
    }

    async getGroup(req: Request, res: Response): Promise<void> {
        const groupId = this.asParam(req.params['groupId']);
        if (groupId !== GROUP_CONFIG.ID) {
            throwEntityNotFound(req.originalUrl, GROUP_CONFIG.TYPE_SINGULAR, groupId);
        }

        const baseUrl = getBaseUrl(req);
        res.json(this.buildGroupEntity(baseUrl));
    }

    async getResources(req: Request, res: Response): Promise<void> {
        const groupId = this.asParam(req.params['groupId']);
        if (groupId !== GROUP_CONFIG.ID) {
            throwEntityNotFound(req.originalUrl, GROUP_CONFIG.TYPE_SINGULAR, groupId);
        }

        const flags = req.xregistryFlags ?? parseRequestFlags(req.query);
        const baseUrl = getBaseUrl(req);

        try {
            const collection = await this.loadPackages(baseUrl, flags);
            this.applyPaginationHeaders(req, res, collection.total, flags.offset, flags.limit);
            res.json(collection.items);
        } catch (error) {
            if (isProblemDetailsError(error)) {
                throw error;
            }
            throwServiceUnavailable(req.originalUrl, error instanceof Error ? error.message : 'Failed to load packages from RubyGems.');
        }
    }

    async getResource(req: Request, res: Response): Promise<void> {
        const groupId = this.asParam(req.params['groupId']);
        const name = this.asParam(req.params['name']);
        if (groupId !== GROUP_CONFIG.ID) {
            throwEntityNotFound(req.originalUrl, GROUP_CONFIG.TYPE_SINGULAR, groupId);
        }

        try {
            const gem = await this.rubygemsService.getGem(name);
            if (!gem) {
                throwEntityNotFound(req.originalUrl, RESOURCE_CONFIG.TYPE_SINGULAR, name);
            }

            const flags = req.xregistryFlags ?? parseRequestFlags(req.query);
            const entity = await this.toPackageEntity(gem, getBaseUrl(req), flags);
            res.json(entity);
        } catch (error) {
            if (isProblemDetailsError(error)) {
                throw error;
            }
            throwServiceUnavailable(req.originalUrl, error instanceof Error ? error.message : 'Failed to load package metadata.');
        }
    }

    async getVersions(req: Request, res: Response): Promise<void> {
        const groupId = this.asParam(req.params['groupId']);
        const name = this.asParam(req.params['name']);
        if (groupId !== GROUP_CONFIG.ID) {
            throwEntityNotFound(req.originalUrl, GROUP_CONFIG.TYPE_SINGULAR, groupId);
        }

        try {
            const versions = await this.rubygemsService.getVersions(name);
            if (versions.length === 0) {
                const gem = await this.rubygemsService.getGem(name);
                if (!gem) {
                    throwEntityNotFound(req.originalUrl, RESOURCE_CONFIG.TYPE_SINGULAR, name);
                }
            }

            const latestGem = await this.rubygemsService.getGem(name);
            const payload = this.buildVersionMap(name, versions, getBaseUrl(req), latestGem);
            res.json(payload);
        } catch (error) {
            if (isProblemDetailsError(error)) {
                throw error;
            }
            throwServiceUnavailable(req.originalUrl, error instanceof Error ? error.message : 'Failed to load package versions.');
        }
    }

    async getVersion(req: Request, res: Response): Promise<void> {
        const groupId = this.asParam(req.params['groupId']);
        const name = this.asParam(req.params['name']);
        const versionId = this.asParam(req.params['versionId']);
        if (groupId !== GROUP_CONFIG.ID) {
            throwEntityNotFound(req.originalUrl, GROUP_CONFIG.TYPE_SINGULAR, groupId);
        }

        try {
            const versions = await this.rubygemsService.getVersions(name);
            if (versions.length === 0) {
                throwEntityNotFound(req.originalUrl, RESOURCE_CONFIG.TYPE_SINGULAR, name);
            }

            parseVersionId(versionId, versions.map((version) => ({ number: version.number, platform: version.platform })));
            const target = versions.find((version) => buildVersionId(version.number, version.platform) === versionId);
            if (!target) {
                throwEntityNotFound(req.originalUrl, 'version', versionId);
            }

            const latestGem = await this.rubygemsService.getGem(name);
            res.json(this.toVersionEntity(name, target, getBaseUrl(req), latestGem));
        } catch (error) {
            if (isProblemDetailsError(error)) {
                throw error;
            }
            throwServiceUnavailable(req.originalUrl, error instanceof Error ? error.message : 'Failed to load version metadata.');
        }
    }

    private asParam(value: string | string[] | undefined): string {
        return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
    }

    private buildGroupEntity(baseUrl: string): Record<string, unknown> {
        const self = `${baseUrl}/${GROUP_CONFIG.TYPE}/${GROUP_CONFIG.ID}`;
        return {
            [`${GROUP_CONFIG.TYPE_SINGULAR}id`]: GROUP_CONFIG.ID,
            xid: `/${GROUP_CONFIG.TYPE}/${GROUP_CONFIG.ID}`,
            self,
            epoch: 1,
            createdat: this.serviceCreatedAt,
            modifiedat: this.serviceCreatedAt,
            name: GROUP_CONFIG.ID,
            description: 'Public RubyGems package registry.',
            [`${RESOURCE_CONFIG.TYPE}url`]: `${self}/${RESOURCE_CONFIG.TYPE}`,
        };
    }

    private async loadPackages(baseUrl: string, flags: XRegistryRequestFlags): Promise<{ items: Record<string, XRegistryPackage>; total: number }> {
        if (flags.filter) {
            const match = flags.filter.match(/^name=(.+)$/);
            if (!match?.[1]) {
                throwInvalidData('/rubyregistries/rubygems.org/packages', 'filter', 'Only filter=name=<gem> is supported.');
            }
            const gem = await this.rubygemsService.getGem(match[1]);
            if (!gem) {
                return { items: {}, total: 0 };
            }
            const entity = await this.toPackageEntity(gem, baseUrl, flags);
            return { items: { [gem.name]: entity }, total: 1 };
        }

        if (flags.search) {
            const results = await this.collectSearchResults(flags.search);
            const paged = results.slice(flags.offset, flags.offset + flags.limit);
            const items = await this.packagesFromMetadata(paged, baseUrl, flags);
            return { items, total: results.length };
        }

        const selectedNames = DEFAULT_PACKAGE_NAMES.slice(flags.offset, flags.offset + flags.limit);
        const packages = await Promise.all(selectedNames.map(async (name) => this.rubygemsService.getGem(name)));
        const metadata = packages.filter((item): item is RubyGemMetadata => item !== null);
        const items = await this.packagesFromMetadata(metadata, baseUrl, flags);
        return { items, total: DEFAULT_PACKAGE_NAMES.length };
    }

    private async collectSearchResults(query: string): Promise<RubyGemMetadata[]> {
        const pages = Array.from({ length: CACHE_CONFIG.MAX_SEARCH_PAGES }, (_, index) => index + 1);
        const results = await Promise.all(pages.map(async (page) => this.rubygemsService.searchGems(query, page)));
        const deduped = new Map<string, RubyGemMetadata>();
        for (const pageResults of results) {
            for (const result of pageResults) {
                if (!deduped.has(result.name)) {
                    deduped.set(result.name, result);
                }
            }
        }
        return Array.from(deduped.values());
    }

    private async packagesFromMetadata(metadata: RubyGemMetadata[], baseUrl: string, flags: XRegistryRequestFlags): Promise<Record<string, XRegistryPackage>> {
        const items = await Promise.all(metadata.map(async (gem) => this.toPackageEntity(gem, baseUrl, flags)));
        return items.reduce<Record<string, XRegistryPackage>>((accumulator, item) => {
            accumulator[item.packageid] = item;
            return accumulator;
        }, {});
    }

    private async toPackageEntity(gem: RubyGemMetadata, baseUrl: string, flags: XRegistryRequestFlags): Promise<XRegistryPackage> {
        const encodedName = encodeGemName(gem.name);
        const self = `${baseUrl}/${GROUP_CONFIG.TYPE}/${GROUP_CONFIG.ID}/${RESOURCE_CONFIG.TYPE}/${encodedName}`;
        const createdAt = this.resolveTimestamp(gem.version_created_at);

        const entity: XRegistryPackage = {
            packageid: gem.name,
            xid: `/${GROUP_CONFIG.TYPE}/${GROUP_CONFIG.ID}/${RESOURCE_CONFIG.TYPE}/${encodedName}`,
            self,
            epoch: 1,
            createdat: createdAt,
            modifiedat: createdAt,
            name: gem.name,
            info: gem.info ?? '',
            version: gem.version,
            authors: gem.authors ?? '',
            licenses: gem.licenses ?? [],
            downloads: gem.downloads ?? 0,
            version_downloads: gem.version_downloads ?? 0,
            platform: gem.platform ?? 'ruby',
            sha: gem.sha ?? '',
            dependencies: this.normalizeDependencies(gem.dependencies),
            versionsurl: `${self}/versions`,
        };

        if (gem.homepage_uri) entity.homepage_uri = gem.homepage_uri;
        if (gem.source_code_uri) entity.source_code_uri = gem.source_code_uri;
        if (gem.changelog_uri) entity.changelog_uri = gem.changelog_uri;
        if (gem.documentation_uri) entity.documentation_uri = gem.documentation_uri;
        if (gem.bug_tracker_uri) entity.bug_tracker_uri = gem.bug_tracker_uri;
        if (gem.gem_uri) entity.gem_uri = gem.gem_uri;
        if (gem.project_uri) entity.project_uri = gem.project_uri;

        if (includesInline(flags, 'versions')) {
            const versions = await this.rubygemsService.getVersions(gem.name);
            entity.versions = this.buildVersionMap(gem.name, versions, baseUrl, gem);
            // Only set versionscount when we already have the list — no extra N+1 fetch.
            entity.versionscount = versions.length;
        }

        return entity;
    }

    private buildVersionMap(name: string, versions: RubyGemVersion[], baseUrl: string, latestGem: RubyGemMetadata | null): Record<string, XRegistryVersion> {
        return versions.reduce<Record<string, XRegistryVersion>>((accumulator, version) => {
            const entity = this.toVersionEntity(name, version, baseUrl, latestGem);
            accumulator[entity.versionid] = entity;
            return accumulator;
        }, {});
    }

    private toVersionEntity(name: string, version: RubyGemVersion, baseUrl: string, latestGem: RubyGemMetadata | null): XRegistryVersion {
        const versionId = buildVersionId(version.number, version.platform);
        const encodedName = encodeGemName(name);
        const encodedVersionId = encodeURIComponent(versionId);
        const self = `${baseUrl}/${GROUP_CONFIG.TYPE}/${GROUP_CONFIG.ID}/${RESOURCE_CONFIG.TYPE}/${encodedName}/versions/${encodedVersionId}`;
        const createdAt = this.resolveTimestamp(version.created_at);
        const latestVersionId = latestGem ? buildVersionId(latestGem.version, latestGem.platform) : undefined;
        const dependencies = latestGem && latestVersionId === versionId
            ? this.normalizeDependencies(latestGem.dependencies)
            : this.normalizeDependencies(undefined);
        const gemUri = latestGem && latestVersionId === versionId && latestGem.gem_uri
            ? latestGem.gem_uri
            : buildGemUri(name, version.number, version.platform);
        const yanked = latestGem && latestVersionId === versionId ? Boolean(latestGem.yanked) : false;

        return {
            versionid: versionId,
            xid: `/${GROUP_CONFIG.TYPE}/${GROUP_CONFIG.ID}/${RESOURCE_CONFIG.TYPE}/${encodedName}/versions/${encodedVersionId}`,
            self,
            epoch: 1,
            createdat: createdAt,
            modifiedat: createdAt,
            name: versionId,
            number: version.number,
            platform: version.platform || 'ruby',
            prerelease: Boolean(version.prerelease),
            created_at: createdAt,
            downloads_count: version.downloads_count ?? 0,
            gem_uri: gemUri,
            sha: version.sha ?? '',
            dependencies,
            yanked,
        };
    }

    private normalizeDependencies(dependencies: RubyGemDependencies | undefined): RubyGemDependencies {
        return {
            development: dependencies?.development ?? [],
            runtime: dependencies?.runtime ?? [],
        };
    }

    private resolveTimestamp(candidate?: string): string {
        if (!candidate) {
            return this.serviceCreatedAt;
        }
        const parsed = Date.parse(candidate);
        return Number.isNaN(parsed) ? this.serviceCreatedAt : new Date(parsed).toISOString();
    }

    private applyPaginationHeaders(req: Request, res: Response, total: number, offset: number, limit: number): void {
        if (total <= 0) {
            return;
        }

        const baseUrl = getBaseUrl(req);
        const buildQueryString = (nextOffset: number): string => {
            const params = new URLSearchParams();
            for (const [key, value] of Object.entries(req.query)) {
                if (Array.isArray(value)) {
                    for (const entry of value) {
                        if (typeof entry === 'string') {
                            params.append(key, entry);
                        }
                    }
                } else if (typeof value === 'string') {
                    params.set(key, value);
                }
            }
            params.set('offset', String(nextOffset));
            params.set('limit', String(limit));
            return params.toString();
        };

        const links: string[] = [];
        if (offset > 0) {
            const prevOffset = Math.max(0, offset - limit);
            links.push(`<${baseUrl}${req.path}?${buildQueryString(prevOffset)}>; rel="prev"`);
        }
        if (offset + limit < total) {
            const nextOffset = offset + limit;
            links.push(`<${baseUrl}${req.path}?${buildQueryString(nextOffset)}>; rel="next"`);
        }

        if (links.length > 0) {
            res.set('Link', links.join(', '));
        }
    }
}
