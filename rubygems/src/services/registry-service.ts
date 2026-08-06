import { Request, Response } from 'express';
import modelData from '../../model.json';
import { getBaseUrl, GROUP_CONFIG, REGISTRY_CONFIG, RESOURCE_CONFIG } from '../config/constants';
import { throwEntityNotFound, throwInvalidData, throwServiceUnavailable, isProblemDetailsError } from '../middleware/xregistry-error-handler';
import { includesInline, parseRequestFlags, XRegistryRequestFlags } from '../middleware/xregistry-flags';
import { RubyGemAttestation, RubyGemDependencies, RubyGemMetadata, RubyGemOwner, RubyGemVersion, XRegistryPackage, XRegistryPackageSummary, XRegistryVersion } from '../types/xregistry';
import { buildFullName, buildGemUri, buildVersionId, encodeGemName, parseVersionId } from '../utils/package-utils';
import { RubyGemsService } from './rubygems-service';

interface PackageCollection {
    items: Record<string, XRegistryPackageSummary>;
    total: number;
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
            this.applyPaginationHeaders(req, res, collection.total, collection.hasMore, flags.offset, flags.limit);
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
            const [gem, versions, owners, reverseDependencies] = await Promise.all([
                this.rubygemsService.getGem(name),
                this.rubygemsService.getVersions(name),
                this.rubygemsService.getOwners(name),
                this.rubygemsService.getReverseDependencies(name),
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
                ...(owners.length > 0 ? { owners: owners.map(owner => this.toOwnerEntity(owner)) } : {}),
                ...(this.isNonEmptyString(gem.project_uri) ? { project_uri: gem.project_uri } : {}),
                ...(typeof gem.downloads === 'number' ? { downloads: gem.downloads } : {}),
                ...(reverseDependencies.length > 0 ? { reverse_dependencies: reverseDependencies } : {}),
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
            const sourceVersions = versions.length > 0 ? versions : this.syntheticVersions(gem);
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

    private packagesPath(): string {
        return `/${GROUP_CONFIG.TYPE}/${GROUP_CONFIG.ID}/${RESOURCE_CONFIG.TYPE}`;
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
            description: 'RubyGems package projection.',
            sourceurl: GROUP_CONFIG.SOURCE_URL,
            [`${RESOURCE_CONFIG.TYPE}url`]: `${self}/${RESOURCE_CONFIG.TYPE}`,
        };
    }

    /**
     * Resolves the requested page of the package collection directly from the
     * full RubyGems names catalogue (see RubyGemsService#getAllNames):
     * `filter=name=<exact>`, `filter=name=<prefix>*`, and free-text `search`
     * are all evaluated against the local, already-sorted name list rather
     * than crawling the upstream search API, which is what let a hard
     * per-search offset cap leak into ordinary catalogue browsing before.
     * Because matching is a bounded in-memory scan over the snapshot, the
     * exact total and limit/offset paging fall out directly with no upstream
     * fan-out and no offset ceiling.
     */
    private async loadPackages(baseUrl: string, flags: XRegistryRequestFlags): Promise<PackageCollection> {
        const names = await this.rubygemsService.getAllNames();
        const matches = this.matchNames(names, flags);
        const total = matches.length;
        const page = matches.slice(flags.offset, flags.offset + flags.limit);

        const items: Record<string, XRegistryPackageSummary> = {};
        for (const name of page) {
            items[name] = this.buildPackageSkeleton(name, baseUrl);
        }
        return { items, total, hasMore: flags.offset + flags.limit < total };
    }

    private matchNames(names: readonly string[], flags: XRegistryRequestFlags): readonly string[] {
        if (flags.filter) {
            const match = flags.filter.match(/^name=(.+?)(\*)?$/);
            if (!match?.[1]) {
                throwInvalidData(this.packagesPath(), 'filter', 'Only filter=name=<gem> or filter=name=<prefix>* is supported.');
            }
            if (match[2]) {
                const prefix = match[1].toLowerCase();
                return names.filter(name => name.toLowerCase().startsWith(prefix));
            }
            const exact = match[1];
            return names.includes(exact) ? [exact] : [];
        }

        if (flags.search) {
            const needle = flags.search.toLowerCase();
            return names.filter(name => name.toLowerCase().includes(needle));
        }

        return names;
    }

    /**
     * Builds a minimal, valid xRegistry Resource identity for a catalogue
     * entry: only `name` is required by the model, so a package collection
     * entry does not need version/gemspec detail to be a well-formed
     * collection member. `createdat`/`modifiedat` reflect when this skeleton
     * was materialized (upstream publish/modification times are only known
     * once the Resource, `/meta`, or `/versions` route fetches the real gem).
     */
    private buildPackageSkeleton(name: string, baseUrl: string): XRegistryPackageSummary {
        const encodedName = encodeGemName(name);
        const xid = `/${GROUP_CONFIG.TYPE}/${GROUP_CONFIG.ID}/${RESOURCE_CONFIG.TYPE}/${encodedName}`;
        const self = `${baseUrl}${xid}`;
        return {
            packageid: name,
            name,
            xid,
            self,
            epoch: 1,
            createdat: this.serviceCreatedAt,
            modifiedat: this.serviceCreatedAt,
            metaurl: `${self}/meta`,
            versionsurl: `${self}/versions`,
        };
    }

    private async toPackageEntity(gem: RubyGemMetadata, baseUrl: string, flags: XRegistryRequestFlags, versionsOverride?: RubyGemVersion[]): Promise<XRegistryPackage> {
        const encodedName = encodeGemName(gem.name);
        const self = `${baseUrl}/${GROUP_CONFIG.TYPE}/${GROUP_CONFIG.ID}/${RESOURCE_CONFIG.TYPE}/${encodedName}`;
        const snapshot = this.buildVersionSnapshot(gem.name, versionsOverride ?? await this.rubygemsService.getVersions(gem.name), baseUrl, gem);
        const current = snapshot.defaultVersion;
        return {
            ...current,
            packageid: gem.name,
            xid: `/${GROUP_CONFIG.TYPE}/${GROUP_CONFIG.ID}/${RESOURCE_CONFIG.TYPE}/${encodedName}`,
            self,
            metaurl: `${self}/meta`,
            versionsurl: `${self}/versions`,
            versionscount: snapshot.ordered.length,
            ...(this.isNonEmptyString(gem.version) ? { version: gem.version } : {}),
            ...(typeof gem.version_downloads === 'number' ? { version_downloads: gem.version_downloads } : {}),
            ...(includesInline(flags, 'versions') ? { versions: snapshot.versions } : {}),
        };
    }

    private syntheticVersions(gem: RubyGemMetadata): RubyGemVersion[] {
        return [{
            created_at: this.resolveTimestamp(gem.version_created_at),
            downloads_count: gem.version_downloads ?? 0,
            number: gem.version,
            platform: gem.platform || 'ruby',
            prerelease: gem.prerelease ?? false,
            ...(this.isNonEmptyString(gem.authors) ? { authors: gem.authors } : {}),
            ...(this.isNonEmptyString(gem.built_at) ? { built_at: gem.built_at } : {}),
            ...(this.isNonEmptyString(gem.description) ? { description: gem.description } : {}),
            ...(gem.metadata ? { metadata: gem.metadata } : {}),
            ...(Array.isArray(gem.licenses) ? { licenses: gem.licenses } : {}),
            ...(Array.isArray(gem.requirements) ? { requirements: gem.requirements } : {}),
            ...(this.isNonEmptyString(gem.ruby_version) ? { ruby_version: gem.ruby_version } : {}),
            ...(this.isNonEmptyString(gem.rubygems_version) ? { rubygems_version: gem.rubygems_version } : {}),
            ...(this.isNonEmptyString(gem.sha) ? { sha: gem.sha } : {}),
            ...(this.isNonEmptyString(gem.spec_sha) ? { spec_sha: gem.spec_sha } : {}),
            ...(this.isNonEmptyString(gem.full_name) ? { full_name: gem.full_name } : {}),
            ...(typeof gem.yanked === 'boolean' ? { yanked: gem.yanked } : {}),
            ...(gem.dependencies ? { dependencies: gem.dependencies } : {}),
            ...(Array.isArray(gem.attestations) ? { attestations: gem.attestations } : {}),
            ...(this.isNonEmptyString(gem.info) ? { summary: gem.info } : {}),
        }];
    }

    private buildVersionSnapshot(name: string, versions: RubyGemVersion[], baseUrl: string, latestGem: RubyGemMetadata | null): CanonicalVersionSnapshot {
        const source = versions.length > 0 ? versions : latestGem ? this.syntheticVersions(latestGem) : [];
        const ordered = source
            .map(version => this.toVersionEntity(name, version, baseUrl, latestGem))
            .sort((a, b) => a.createdat.localeCompare(b.createdat) || a.versionid.localeCompare(b.versionid, undefined, { sensitivity: 'base' }) || a.versionid.localeCompare(b.versionid));
        const defaultVersion = [...ordered].reverse().find(version => version['yanked'] !== true) ?? ordered.at(-1);
        if (!defaultVersion) {
            throwEntityNotFound(`/${GROUP_CONFIG.TYPE}/${GROUP_CONFIG.ID}/${RESOURCE_CONFIG.TYPE}/${name}`, 'package', name);
        }
        ordered.forEach((version, index) => {
            version.ancestor = index === 0 ? version.versionid : ordered[index - 1]!.versionid;
            version.isdefault = version.versionid === defaultVersion.versionid;
        });
        return {
            versions: Object.fromEntries([...ordered]
                .sort((a, b) => a.versionid.localeCompare(b.versionid, undefined, { sensitivity: 'base' }) || a.versionid.localeCompare(b.versionid))
                .map(entity => [entity.versionid, entity])),
            ordered,
            defaultVersion,
            createdat: ordered[0]!.createdat,
            modifiedat: defaultVersion.createdat,
        };
    }

    private toVersionEntity(name: string, version: RubyGemVersion, baseUrl: string, latestGem: RubyGemMetadata | null): XRegistryVersion {
        const platform = version.platform || 'ruby';
        const versionId = buildVersionId(version.number, platform);
        const encodedName = encodeGemName(name);
        const encodedVersionId = encodeURIComponent(versionId);
        const self = `${baseUrl}/${GROUP_CONFIG.TYPE}/${GROUP_CONFIG.ID}/${RESOURCE_CONFIG.TYPE}/${encodedName}/versions/${encodedVersionId}`;
        const createdAt = this.resolveTimestamp(version.created_at);
        const latestVersionId = latestGem ? buildVersionId(latestGem.version, latestGem.platform || 'ruby') : undefined;
        const isLatestGemTuple = latestVersionId === versionId;
        const metadata = this.normalizeMetadata(version.metadata ?? (isLatestGemTuple ? latestGem?.metadata : undefined));
        const dependencies = this.normalizeDependencies(version.dependencies ?? (isLatestGemTuple ? latestGem?.dependencies : undefined));
        const licenses = this.normalizeStringArray(version.licenses);
        const requirements = this.normalizeStringArray(version.requirements);
        const declaredUris = this.resolveDeclaredUriAttributes(metadata, isLatestGemTuple ? latestGem : null);
        const yanked = typeof version.yanked === 'boolean' ? version.yanked : isLatestGemTuple && typeof latestGem?.yanked === 'boolean' ? latestGem.yanked : undefined;
        const fullName = this.resolveString(version.full_name) ?? (isLatestGemTuple ? this.resolveString(latestGem?.full_name) : undefined) ?? buildFullName(name, version.number, platform);
        const gemUri = isLatestGemTuple && this.isNonEmptyString(latestGem?.gem_uri) ? latestGem.gem_uri : buildGemUri(name, version.number, platform);
        const attestations = this.normalizeAttestations(version.attestations ?? (isLatestGemTuple ? latestGem?.attestations : undefined));
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
            number: version.number,
            platform,
            prerelease: Boolean(version.prerelease),
            created_at: createdAt,
            downloads_count: version.downloads_count ?? 0,
            gem_uri: gemUri,
            full_name: fullName,
            ...(this.isNonEmptyString(version.summary) ? { info: version.summary } : {}),
            ...(this.isNonEmptyString(version.description) ? { description: version.description } : {}),
            ...(this.isNonEmptyString(latestGem?.version) ? { version: latestGem.version } : {}),
            ...(typeof latestGem?.version_downloads === 'number' ? { version_downloads: latestGem.version_downloads } : {}),
            ...(this.isNonEmptyString(version.authors) ? { authors: version.authors } : {}),
            ...(licenses ? { licenses } : {}),
            ...(this.isNonEmptyString(version.sha) ? { sha: version.sha } : {}),
            ...(this.isNonEmptyString(version.spec_sha) ? { spec_sha: version.spec_sha } : {}),
            ...(this.isNonEmptyString(version.ruby_version) ? { ruby_version: version.ruby_version } : {}),
            ...(this.isNonEmptyString(version.rubygems_version) ? { rubygems_version: version.rubygems_version } : {}),
            ...(requirements ? { requirements } : {}),
            ...(this.isNonEmptyString(version.built_at) ? { built_at: this.resolveTimestamp(version.built_at) } : {}),
            ...(metadata ? { metadata } : {}),
            ...(attestations ? { attestations } : {}),
            ...(dependencies ? { dependencies } : {}),
            ...(typeof yanked === 'boolean' ? { yanked } : {}),
            ...declaredUris,
        };
    }

    private toOwnerEntity(owner: RubyGemOwner): Record<string, string> {
        return {
            handle: owner.handle,
            ...(this.isNonEmptyString(owner.role) ? { role: owner.role } : {}),
        };
    }

    private normalizeDependencies(dependencies: RubyGemDependencies | undefined): RubyGemDependencies | undefined {
        if (!dependencies) {
            return undefined;
        }
        return {
            development: dependencies.development ?? [],
            runtime: dependencies.runtime ?? [],
        };
    }

    private normalizeStringArray(values: string[] | null | undefined): string[] | undefined {
        if (!Array.isArray(values)) {
            return undefined;
        }
        const normalized = values.filter((value): value is string => typeof value === 'string' && value.length > 0);
        return normalized.length > 0 ? normalized : undefined;
    }

    private normalizeMetadata(metadata: Record<string, string | null> | null | undefined): Record<string, string> | undefined {
        if (!metadata || typeof metadata !== 'object') {
            return undefined;
        }
        const normalized = Object.fromEntries(Object.entries(metadata).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
        return Object.keys(normalized).length > 0 ? normalized : undefined;
    }

    private normalizeAttestations(attestations: RubyGemAttestation[] | null | undefined): RubyGemAttestation[] | undefined {
        if (!Array.isArray(attestations)) {
            return undefined;
        }
        const normalized = attestations.filter((attestation): attestation is RubyGemAttestation => typeof attestation?.media_type === 'string' && !!attestation.media_type && !!attestation.bundle && typeof attestation.bundle === 'object');
        return normalized.length > 0 ? normalized : undefined;
    }

    private resolveDeclaredUriAttributes(metadata: Record<string, string> | undefined, latestGem: RubyGemMetadata | null): Record<string, string> {
        const keys = ['homepage_uri', 'source_code_uri', 'changelog_uri', 'documentation_uri', 'bug_tracker_uri'] as const;
        const result: Record<string, string> = {};
        for (const key of keys) {
            const value = this.resolveString(metadata?.[key]) ?? this.resolveString(latestGem?.[key]);
            if (value) {
                result[key] = value;
            }
        }
        return result;
    }

    private resolveString(value: unknown): string | undefined {
        return typeof value === 'string' && value.length > 0 ? value : undefined;
    }

    private isNonEmptyString(value: unknown): value is string {
        return typeof value === 'string' && value.length > 0;
    }

    private resolveTimestamp(candidate?: string): string {
        if (!candidate) {
            return this.serviceCreatedAt;
        }
        const parsed = Date.parse(candidate);
        return Number.isNaN(parsed) ? this.serviceCreatedAt : new Date(parsed).toISOString();
    }

    private applyPaginationHeaders(req: Request, res: Response, total: number, hasMore: boolean, offset: number, limit: number): void {
        res.set('X-Total-Count', String(total));
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
            links.push(`<${baseUrl}${req.path}?${buildQueryString(0)}>; rel="first"`);
            links.push(`<${baseUrl}${req.path}?${buildQueryString(prevOffset)}>; rel="prev"`);
        }
        if (hasMore) {
            const nextOffset = offset + limit;
            links.push(`<${baseUrl}${req.path}?${buildQueryString(nextOffset)}>; rel="next"`);
            const lastOffset = Math.floor((total - 1) / limit) * limit;
            links.push(`<${baseUrl}${req.path}?${buildQueryString(lastOffset)}>; rel="last"`);
        }

        if (links.length > 0) {
            res.set('Link', links.join(', '));
        }
    }
}
