import { isUpstreamError } from '@xregistry/registry-core';
import { Request, Response } from 'express';
import modelData from '../../model.json';
import { CACHE_CONFIG, getBaseUrl, GROUP_CONFIG, PAGINATION, REGISTRY_CONFIG, RESOURCE_CONFIG } from '../config/constants';
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

interface PackageCollection {
    items: Record<string, XRegistryPackage>;
    total?: number;
    hasMore: boolean;
}

interface CanonicalVersionSnapshot {
    versions: Record<string, XRegistryVersion>;
    ordered: XRegistryVersion[];
    defaultVersion: XRegistryVersion;
    createdat: string;
    modifiedat: string;
}

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
            const maxOffset = flags.search || flags.filter ? PAGINATION.MAX_SEARCH_OFFSET : undefined;
            this.applyPaginationHeaders(
                req,
                res,
                collection.total,
                collection.hasMore,
                flags.offset,
                flags.limit,
                maxOffset,
            );
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
            if (!gem || gem.name !== name) {
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

    async getMeta(req: Request, res: Response): Promise<void> {
        const groupId = this.asParam(req.params['groupId']);
        const name = this.asParam(req.params['name']);
        if (groupId !== GROUP_CONFIG.ID) {
            throwEntityNotFound(req.originalUrl, GROUP_CONFIG.TYPE_SINGULAR, groupId);
        }

        try {
            const [gem, versions] = await Promise.all([
                this.rubygemsService.getGem(name),
                this.rubygemsService.getVersions(name),
            ]);
            if (!gem || gem.name !== name) {
                throwEntityNotFound(req.originalUrl, RESOURCE_CONFIG.TYPE_SINGULAR, name);
            }
            const snapshot = this.buildVersionSnapshot(name, versions, getBaseUrl(req), gem);
            const encodedName = encodeGemName(name);
            const resourcePath = `/${GROUP_CONFIG.TYPE}/${GROUP_CONFIG.ID}/${RESOURCE_CONFIG.TYPE}/${encodedName}`;
            const resourceSelf = `${getBaseUrl(req)}${resourcePath}`;
            res.json({
                [`${RESOURCE_CONFIG.TYPE_SINGULAR}id`]: name,
                xid: `${resourcePath}/meta`,
                self: `${resourceSelf}/meta`,
                epoch: 1,
                createdat: snapshot.createdat,
                modifiedat: snapshot.modifiedat,
                readonly: true,
                compatibility: 'none',
                defaultversionid: snapshot.defaultVersion.versionid,
                defaultversionurl: `${resourceSelf}/versions/${encodeURIComponent(snapshot.defaultVersion.versionid)}`,
                defaultversionsticky: false,
                ...(gem?.homepage_uri ? { homepage_uri: gem.homepage_uri } : {}),
                ...(gem?.source_code_uri ? { source_code_uri: gem.source_code_uri } : {}),
                ...(gem?.changelog_uri ? { changelog_uri: gem.changelog_uri } : {}),
                ...(gem?.documentation_uri ? { documentation_uri: gem.documentation_uri } : {}),
                ...(gem?.bug_tracker_uri ? { bug_tracker_uri: gem.bug_tracker_uri } : {}),
                ...(gem?.project_uri ? { project_uri: gem.project_uri } : {}),
                ...(gem ? { downloads: gem.downloads ?? 0 } : {}),
            });
        } catch (error) {
            if (isProblemDetailsError(error)) throw error;
            throwServiceUnavailable(req.originalUrl, error instanceof Error ? error.message : 'Failed to load package meta.');
        }
    }

    async getVersions(req: Request, res: Response): Promise<void> {
        const groupId = this.asParam(req.params['groupId']);
        const name = this.asParam(req.params['name']);
        if (groupId !== GROUP_CONFIG.ID) {
            throwEntityNotFound(req.originalUrl, GROUP_CONFIG.TYPE_SINGULAR, groupId);
        }

        try {
            const [versions, gem] = await Promise.all([
                this.rubygemsService.getVersions(name),
                this.rubygemsService.getGem(name),
            ]);
            if (!gem || gem.name !== name) {
                throwEntityNotFound(req.originalUrl, RESOURCE_CONFIG.TYPE_SINGULAR, name);
            }
            res.json(this.buildVersionSnapshot(name, versions, getBaseUrl(req), gem).versions);
        } catch (error) {
            if (isProblemDetailsError(error)) throw error;
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
            const [versions, gem] = await Promise.all([
                this.rubygemsService.getVersions(name),
                this.rubygemsService.getGem(name),
            ]);
            if (!gem || gem.name !== name) {
                throwEntityNotFound(req.originalUrl, RESOURCE_CONFIG.TYPE_SINGULAR, name);
            }
            const sourceVersions = versions.length > 0 ? versions : this.syntheticVersions(gem!);
            parseVersionId(versionId, sourceVersions.map((version) => ({ number: version.number, platform: version.platform })));
            const snapshot = this.buildVersionSnapshot(name, versions, getBaseUrl(req), gem);
            const target = snapshot.versions[versionId];
            if (!target) throwEntityNotFound(req.originalUrl, 'version', versionId);
            res.json(target);
        } catch (error) {
            if (isProblemDetailsError(error)) throw error;
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

    private async loadPackages(baseUrl: string, flags: XRegistryRequestFlags): Promise<PackageCollection> {
        if (flags.filter) {
            const match = flags.filter.match(/^name=(.+?)(\*)?$/);
            if (!match?.[1]) {
                throwInvalidData('/rubyregistries/rubygems.org/packages', 'filter', 'Only filter=name=<gem> or filter=name=<prefix>* is supported.');
            }
            if (match[2]) {
                const prefix = match[1];
                return this.loadSearchPackages(
                    prefix,
                    baseUrl,
                    flags,
                    (gem) => gem.name.toLowerCase().startsWith(prefix.toLowerCase()),
                );
            }
            const gem = await this.rubygemsService.getGem(match[1]);
            if (!gem) {
                return { items: {}, total: 0, hasMore: false };
            }
            const entity = await this.toPackageEntity(gem, baseUrl, flags);
            return { items: { [gem.name]: entity }, total: 1, hasMore: false };
        }

        if (flags.search) {
            return this.loadSearchPackages(flags.search, baseUrl, flags);
        }

        const selectedNames = DEFAULT_PACKAGE_NAMES.slice(flags.offset, flags.offset + flags.limit);
        const packages = await Promise.all(selectedNames.map(async (name) => this.rubygemsService.getGem(name)));
        const metadata = packages.filter((item): item is RubyGemMetadata => item !== null);
        const items = await this.packagesFromMetadata(metadata, baseUrl, flags);
        return { items, total: DEFAULT_PACKAGE_NAMES.length, hasMore: flags.offset + flags.limit < DEFAULT_PACKAGE_NAMES.length };
    }

    private async loadSearchPackages(
        query: string,
        baseUrl: string,
        flags: XRegistryRequestFlags,
        predicate: (gem: RubyGemMetadata) => boolean = () => true,
    ): Promise<PackageCollection> {
        if (flags.offset > PAGINATION.MAX_SEARCH_OFFSET) {
            throwInvalidData(
                '/rubyregistries/rubygems.org/packages',
                'offset',
                `Search offsets greater than ${PAGINATION.MAX_SEARCH_OFFSET} are not supported.`,
            );
        }

        const targetCount = flags.offset + flags.limit + 1;
        const deduped = new Map<string, RubyGemMetadata>();
        const seenUpstreamNames = new Set<string>();
        let page = 1;
        let exhausted = false;

        while (deduped.size < targetCount) {
            if (page > CACHE_CONFIG.MAX_SEARCH_PAGES) {
                throwInvalidData(
                    '/rubyregistries/rubygems.org/packages',
                    'offset',
                    `Search requires more than the safe limit of ${CACHE_CONFIG.MAX_SEARCH_PAGES} upstream pages.`,
                );
            }

            const pageResults = await this.rubygemsService.searchGems(query, page);
            const seenBefore = seenUpstreamNames.size;
            for (const result of pageResults) {
                seenUpstreamNames.add(result.name);
                if (predicate(result) && !deduped.has(result.name)) {
                    deduped.set(result.name, result);
                }
            }
            if (seenUpstreamNames.size === seenBefore) {
                exhausted = true;
                break;
            }
            if (pageResults.length < CACHE_CONFIG.SEARCH_PER_PAGE) {
                exhausted = true;
                break;
            }
            page += 1;
        }

        const results = Array.from(deduped.values());
        const paged = results.slice(flags.offset, flags.offset + flags.limit);
        return {
            items: await this.packagesFromMetadata(paged, baseUrl, flags),
            ...(exhausted ? { total: results.length } : {}),
            hasMore: results.length > flags.offset + flags.limit || !exhausted,
        };
    }

    private async packagesFromMetadata(metadata: RubyGemMetadata[], baseUrl: string, flags: XRegistryRequestFlags): Promise<Record<string, XRegistryPackage>> {
        const settled = await Promise.allSettled(metadata.map(gem => this.toPackageEntity(gem, baseUrl, flags)));
        const result: Record<string, XRegistryPackage> = {};
        for (let index = 0; index < settled.length; index += 1) {
            const item = settled[index]!;
            if (item.status === 'fulfilled') {
                result[item.value.packageid] = item.value;
                continue;
            }
            const gem = metadata[index]!;
            if (isUpstreamError(item.reason) && item.reason.code === 'rate_limited') {
                // Preserve the collection page using the search/gem summary as
                // a one-Version snapshot; one 429 never fans out more work or
                // collapses unrelated hydrated Resources.
                const fallback = await this.toPackageEntity(gem, baseUrl, flags, []);
                result[fallback.packageid] = fallback;
                continue;
            }
            throw item.reason;
        }
        return result;
    }

    private async toPackageEntity(
        gem: RubyGemMetadata,
        baseUrl: string,
        flags: XRegistryRequestFlags,
        versionsOverride?: RubyGemVersion[],
    ): Promise<XRegistryPackage> {
        const encodedName = encodeGemName(gem.name);
        const self = `${baseUrl}/${GROUP_CONFIG.TYPE}/${GROUP_CONFIG.ID}/${RESOURCE_CONFIG.TYPE}/${encodedName}`;
        const snapshot = this.buildVersionSnapshot(
            gem.name,
            versionsOverride ?? await this.rubygemsService.getVersions(gem.name),
            baseUrl,
            gem,
        );
        const current = snapshot.defaultVersion;
        const entity = {
            ...current,
            packageid: gem.name,
            xid: `/${GROUP_CONFIG.TYPE}/${GROUP_CONFIG.ID}/${RESOURCE_CONFIG.TYPE}/${encodedName}`,
            self,
            metaurl: `${self}/meta`,
            versionsurl: `${self}/versions`,
            versionscount: snapshot.ordered.length,
            ...(includesInline(flags, 'versions') ? { versions: snapshot.versions } : {}),
        } as XRegistryPackage;
        return entity;
    }

    private syntheticVersions(gem: RubyGemMetadata): RubyGemVersion[] {
        return [{
            authors: gem.authors ?? '',
            created_at: this.resolveTimestamp(gem.version_created_at),
            downloads_count: gem.version_downloads ?? 0,
            number: gem.version,
            platform: gem.platform || 'ruby',
            prerelease: false,
            licenses: gem.licenses ?? [],
            sha: gem.sha ?? '',
        }];
    }

    private buildVersionSnapshot(
        name: string,
        versions: RubyGemVersion[],
        baseUrl: string,
        latestGem: RubyGemMetadata | null,
    ): CanonicalVersionSnapshot {
        const source = versions.length > 0
            ? versions
            : latestGem
                ? this.syntheticVersions(latestGem)
                : [];
        const ordered = source
            .map(version => this.toVersionEntity(name, version, baseUrl, latestGem))
            .sort((a, b) =>
                a.createdat.localeCompare(b.createdat) ||
                a.versionid.localeCompare(b.versionid, undefined, { sensitivity: 'base' }) ||
                a.versionid.localeCompare(b.versionid),
            );
        const defaultVersion = ordered.at(-1);
        if (!defaultVersion) {
            throwEntityNotFound(`/${GROUP_CONFIG.TYPE}/${GROUP_CONFIG.ID}/${RESOURCE_CONFIG.TYPE}/${name}`, 'package', name);
        }
        ordered.forEach((version, index) => {
            version.ancestor = index === 0 ? version.versionid : ordered[index - 1]!.versionid;
            version.isdefault = version.versionid === defaultVersion.versionid;
        });
        return {
            versions: Object.fromEntries([...ordered]
                .sort((a, b) =>
                    a.versionid.localeCompare(b.versionid, undefined, { sensitivity: 'base' }) ||
                    a.versionid.localeCompare(b.versionid),
                )
                .map(entity => [entity.versionid, entity])),
            ordered,
            defaultVersion,
            createdat: ordered[0]!.createdat,
            modifiedat: defaultVersion.createdat,
        };
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
            packageid: name,
            isdefault: false,
            ancestor: versionId,
            xid: `/${GROUP_CONFIG.TYPE}/${GROUP_CONFIG.ID}/${RESOURCE_CONFIG.TYPE}/${encodedName}/versions/${encodedVersionId}`,
            self,
            epoch: 1,
            createdat: createdAt,
            modifiedat: createdAt,
            name,
            info: version.description ?? version.summary ?? (latestGem && latestVersionId === versionId ? latestGem.info : ''),
            version: version.number,
            authors: version.authors ?? '',
            licenses: version.licenses ?? [],
            number: version.number,
            platform: version.platform || 'ruby',
            prerelease: Boolean(version.prerelease),
            created_at: createdAt,
            downloads_count: version.downloads_count ?? 0,
            version_downloads: version.downloads_count ?? 0,
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

    private applyPaginationHeaders(
        req: Request,
        res: Response,
        total: number | undefined,
        hasMore: boolean,
        offset: number,
        limit: number,
        maxOffset?: number,
    ): void {
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
        if (hasMore || (total !== undefined && offset + limit < total)) {
            const nextOffset = offset + limit;
            if (maxOffset === undefined || nextOffset <= maxOffset) {
                links.push(`<${baseUrl}${req.path}?${buildQueryString(nextOffset)}>; rel="next"`);
            }
        }

        if (links.length > 0) {
            res.set('Link', links.join(', '));
        }
    }
}
