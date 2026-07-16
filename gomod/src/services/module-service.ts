/**
 * Module Service — maps GOPROXY data to xRegistry module and version records.
 */

import { EntityStateManager } from '../../../shared/entity-state-manager';
import { getBaseUrl, REGISTRY_METADATA } from '../config/constants';
import { ModuleRecord, VersionRecord } from '../types/go';
import { isPreRelease, isPseudoVersion, pseudoVersionTimestamp } from '../utils/path-escaping';
import { CheckpointService } from './checkpoint-service';
import { GoModuleService } from './go-module-service';
import { Request } from 'express';

const { GROUP_TYPE, GROUP_ID, RESOURCE_TYPE, RESOURCE_TYPE_SINGULAR } = REGISTRY_METADATA;

export class ModuleService {
    constructor(
        private readonly goService: GoModuleService,
        private readonly checkpoint: CheckpointService,
        private readonly entityState: EntityStateManager
    ) {}

    // -------------------------------------------------------------------------
    // Module-level records
    // -------------------------------------------------------------------------

    private moduleXPath(modulePath: string): string {
        return `/${GROUP_TYPE}/${GROUP_ID}/${RESOURCE_TYPE}/${modulePath}`;
    }

    private moduleBaseUrl(baseUrl: string, modulePath: string): string {
        return `${baseUrl}/${GROUP_TYPE}/${GROUP_ID}/${RESOURCE_TYPE}/${encodeURIComponent(modulePath)}`;
    }

    private inferRepository(modulePath: string): string {
        const parts = modulePath.split('/');
        if (parts.length >= 2) {
            const host = parts[0];
            const owner = parts[1];
            const repo = parts[2] ?? '';
            if (host === 'github.com' || host === 'gitlab.com' || host === 'bitbucket.org') {
                return `https://${host}/${owner}/${repo}`;
            }
        }
        return `https://${modulePath}`;
    }

    /**
     * Build a ModuleRecord from catalog + live GOPROXY data for the default version.
     */
    async getModule(req: Request, modulePath: string): Promise<ModuleRecord | null> {
        const baseUrl = getBaseUrl(req);
        const catalogEntry = this.checkpoint.getModule(modulePath);
        const latest = catalogEntry
            ? catalogEntry.latestVersion
            : (await this.goService.getLatest(modulePath))?.Version ?? null;

        if (!latest) return null;

        const info = await this.goService.getVersionInfo(modulePath, latest);
        if (!info) return null;

        const xp = this.moduleXPath(modulePath);
        const selfUrl = this.moduleBaseUrl(baseUrl, modulePath);

        const allVersions = catalogEntry
            ? catalogEntry.versions
            : await this.goService.listVersions(modulePath);

        return {
            [`${RESOURCE_TYPE_SINGULAR}id`]: modulePath,
            xid: xp,
            name: modulePath,
            self: selfUrl,
            epoch: this.entityState.getEpoch(xp),
            createdat: this.entityState.getCreatedAt(xp),
            modifiedat: info.Time || this.entityState.getModifiedAt(xp),
            versionsurl: `${selfUrl}/versions`,
            versionscount: allVersions.length,
            latest_version: latest,
            repository: this.inferRepository(modulePath),
            info_url: this.goService.proxyUrl(modulePath, latest, 'info'),
            mod_url: this.goService.proxyUrl(modulePath, latest, 'mod'),
            zip_url: this.goService.proxyUrl(modulePath, latest, 'zip'),
            pseudo_version: isPseudoVersion(latest),
            pre_release: isPreRelease(latest),
        } as unknown as ModuleRecord;
    }

    // -------------------------------------------------------------------------
    // Version-level records
    // -------------------------------------------------------------------------

    private versionXPath(modulePath: string, version: string): string {
        return `/${GROUP_TYPE}/${GROUP_ID}/${RESOURCE_TYPE}/${modulePath}/versions/${version}`;
    }

    private versionBaseUrl(baseUrl: string, modulePath: string, version: string): string {
        return (
            `${baseUrl}/${GROUP_TYPE}/${GROUP_ID}/${RESOURCE_TYPE}/` +
            `${encodeURIComponent(modulePath)}/versions/${encodeURIComponent(version)}`
        );
    }

    /**
     * Build a VersionRecord from GOPROXY data for one specific version.
     */
    async getVersion(
        req: Request,
        modulePath: string,
        version: string
    ): Promise<VersionRecord | null> {
        const baseUrl = getBaseUrl(req);
        const info = await this.goService.getVersionInfo(modulePath, version);
        if (!info) return null;

        const xp = this.versionXPath(modulePath, version);
        const selfUrl = this.versionBaseUrl(baseUrl, modulePath, version);

        // Prefer the timestamp from the .info response; fall back to pseudo-version extraction.
        const ts = info.Time || pseudoVersionTimestamp(version) || new Date().toISOString();

        return {
            versionid: version,
            xid: xp,
            self: selfUrl,
            epoch: this.entityState.getEpoch(xp),
            createdat: ts,
            modifiedat: ts,
            name: modulePath,
            version: info.Version,
            timestamp: ts,
            info_url: this.goService.proxyUrl(modulePath, version, 'info'),
            mod_url: this.goService.proxyUrl(modulePath, version, 'mod'),
            zip_url: this.goService.proxyUrl(modulePath, version, 'zip'),
            pseudo_version: isPseudoVersion(version),
            pre_release: isPreRelease(version),
            gomod_hash: null,
            zip_hash: null,
        };
    }

    /**
     * List all versions for a module, paginated.
     * Versions are immutable — order is ascending by version string.
     */
    async listVersions(
        req: Request,
        modulePath: string,
        offset: number,
        limit: number
    ): Promise<{ versions: VersionRecord[]; totalCount: number } | null> {
        const baseUrl = getBaseUrl(req);
        const catalogEntry = this.checkpoint.getModule(modulePath);
        let allVersions: string[];

        if (catalogEntry && catalogEntry.versions.length > 0) {
            allVersions = [...catalogEntry.versions].sort();
        } else {
            allVersions = await this.goService.listVersions(modulePath);
        }

        if (allVersions.length === 0) return null;

        const page = allVersions.slice(offset, offset + limit);
        const records: VersionRecord[] = [];

        for (const version of page) {
            const info = await this.goService.getVersionInfo(modulePath, version);
            if (!info) continue;
            const xp = this.versionXPath(modulePath, version);
            const selfUrl = this.versionBaseUrl(baseUrl, modulePath, version);
            const ts = info.Time || pseudoVersionTimestamp(version) || new Date().toISOString();

            records.push({
                versionid: version,
                xid: xp,
                self: selfUrl,
                epoch: this.entityState.getEpoch(xp),
                createdat: ts,
                modifiedat: ts,
                name: modulePath,
                version: info.Version,
                timestamp: ts,
                info_url: this.goService.proxyUrl(modulePath, version, 'info'),
                mod_url: this.goService.proxyUrl(modulePath, version, 'mod'),
                zip_url: this.goService.proxyUrl(modulePath, version, 'zip'),
                pseudo_version: isPseudoVersion(version),
                pre_release: isPreRelease(version),
                gomod_hash: null,
                zip_hash: null,
            });
        }

        return { versions: records, totalCount: allVersions.length };
    }
}
