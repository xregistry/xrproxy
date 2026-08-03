/**
 * Module Service — maps GOPROXY and checksum-db data to xRegistry records.
 */

import { Request } from 'express';
import { EntityStateManager } from '../../../shared/entity-state-manager';
import { getBaseUrl, REGISTRY_METADATA } from '../config/constants';
import {
    GoChecksumRecord,
    GoEffectiveRetraction,
    ModuleMetaRecord,
    ModuleRecord,
    ParsedGoMod,
    VersionRecord,
} from '../types/go';
import {
    isIncompatibleVersion,
    isPreRelease,
    isPseudoVersion,
    majorVersionSuffix,
    pseudoVersionTimestamp,
    versionToId,
} from '../utils/path-escaping';
import { CheckpointService } from './checkpoint-service';
import { GoModuleService } from './go-module-service';

const { GROUP_TYPE, RESOURCE_TYPE, RESOURCE_TYPE_SINGULAR } = REGISTRY_METADATA;

interface VersionMaterial {
    version: string;
    infoTime?: string;
    gomod?: ParsedGoMod | null;
    checksums?: GoChecksumRecord;
}

export class ModuleService {
    constructor(
        private readonly goService: GoModuleService,
        private readonly checkpoint: CheckpointService,
        private readonly entityState: EntityStateManager
    ) {}

    private moduleIdentity(modulePath: string) {
        return this.checkpoint.getModuleIdentity(modulePath);
    }

    private moduleXPath(modulePath: string): string {
        const { groupId, moduleId } = this.moduleIdentity(modulePath);
        return `/${GROUP_TYPE}/${groupId}/${RESOURCE_TYPE}/${moduleId}`;
    }

    private moduleBaseUrl(baseUrl: string, modulePath: string): string {
        const { groupId, moduleId } = this.moduleIdentity(modulePath);
        return `${baseUrl}/${GROUP_TYPE}/${encodeURIComponent(groupId)}/${RESOURCE_TYPE}/${encodeURIComponent(moduleId)}`;
    }

    private inferRepository(modulePath: string): string | undefined {
        const parts = modulePath.split('/');
        if (parts.length < 3) return undefined;
        const host = parts[0];
        const owner = parts[1];
        const repo = parts[2];
        if (host === 'github.com' || host === 'gitlab.com' || host === 'bitbucket.org') {
            return `https://${host}/${owner}/${repo}`;
        }
        return undefined;
    }

    private entityTimestampFields(timestamp: string | null | undefined): {
        createdat?: string;
        modifiedat?: string;
    } {
        if (!timestamp || Number.isNaN(Date.parse(timestamp))) return {};
        return {
            createdat: timestamp,
            modifiedat: timestamp,
        };
    }

    private versionTimestampFields(timestamp: string | null | undefined): {
        createdat?: string;
        modifiedat?: string;
        timestamp?: string;
    } {
        const entityFields = this.entityTimestampFields(timestamp);
        if (!entityFields.createdat) return {};
        return { ...entityFields, timestamp: entityFields.createdat };
    }

    private buildMeta(modulePath: string, latestVersion: string | undefined, latestGoMod: ParsedGoMod | null | undefined): ModuleMetaRecord | undefined {
        const meta: ModuleMetaRecord = {};
        if (latestVersion) meta.latest_version = latestVersion;

        const repository = this.inferRepository(modulePath);
        if (repository) meta.repository = repository;

        const suffix = majorVersionSuffix(modulePath);
        if (suffix) meta.major_version_suffix = suffix;

        if (latestGoMod?.deprecatedMessage) {
            meta.deprecated_message = latestGoMod.deprecatedMessage;
        }

        if (latestVersion && latestGoMod?.retract?.length) {
            meta.retractions = latestGoMod.retract.map((entry): GoEffectiveRetraction => ({
                ...entry,
                declared_in: latestVersion,
            }));
        }

        return Object.keys(meta).length > 0 ? meta : undefined;
    }

    private async loadVersionMaterial(modulePath: string, version: string): Promise<VersionMaterial | null> {
        const info = await this.goService.getVersionInfo(modulePath, version);
        if (!info) return null;

        const gomod = await this.goService.getParsedGoMod(modulePath, info.Version);
        const checksums = await this.goService.getChecksumRecord(modulePath, info.Version);
        return {
            version: info.Version,
            infoTime: info.Time || pseudoVersionTimestamp(info.Version) || undefined,
            gomod,
            checksums,
        };
    }

    private buildVersionRecord(
        req: Request,
        modulePath: string,
        material: VersionMaterial,
        defaultVersion: string | undefined
    ): VersionRecord {
        const baseUrl = getBaseUrl(req);
        const versionId = versionToId(material.version);
        const moduleXPath = this.moduleXPath(modulePath);
        const xp = `${moduleXPath}/versions/${versionId}`;
        const selfUrl = `${this.moduleBaseUrl(baseUrl, modulePath)}/versions/${encodeURIComponent(versionId)}`;

        return {
            versionid: versionId,
            isdefault: material.version === defaultVersion,
            xid: xp,
            self: selfUrl,
            ancestor: moduleXPath,
            epoch: this.entityState.getEpoch(xp),
            ...this.versionTimestampFields(material.infoTime),
            name: modulePath,
            version: material.version,
            modulepath: modulePath,
            info_url: this.goService.proxyUrl(modulePath, material.version, 'info'),
            mod_url: this.goService.proxyUrl(modulePath, material.version, 'mod'),
            zip_url: this.goService.proxyUrl(modulePath, material.version, 'zip'),
            ...(material.checksums?.gomodHash ? { gomod_hash: material.checksums.gomodHash } : {}),
            ...(material.checksums?.zipHash ? { zip_hash: material.checksums.zipHash } : {}),
            pseudo_version: isPseudoVersion(material.version),
            pre_release: isPreRelease(material.version),
            incompatible: isIncompatibleVersion(material.version),
            ...(material.gomod?.goVersion ? { go_version: material.gomod.goVersion } : {}),
            ...(material.gomod?.toolchain ? { toolchain: material.gomod.toolchain } : {}),
            ...(material.gomod?.require?.length ? { require: material.gomod.require } : {}),
            ...(material.gomod?.replace?.length ? { replace: material.gomod.replace } : {}),
            ...(material.gomod?.exclude?.length ? { exclude: material.gomod.exclude } : {}),
            ...(material.gomod?.retract?.length ? { retract: material.gomod.retract } : {}),
            ...(material.gomod?.godebug && Object.keys(material.gomod.godebug).length ? { godebug: material.gomod.godebug } : {}),
            ...(material.gomod?.tool?.length ? { tool: material.gomod.tool } : {}),
            ...(material.gomod?.ignore?.length ? { ignore: material.gomod.ignore } : {}),
        };
    }

    async getModule(req: Request, modulePath: string): Promise<ModuleRecord | null> {
        const baseUrl = getBaseUrl(req);
        const catalogEntry = this.checkpoint.getModule(modulePath);
        const latestInfo = await this.goService.getLatest(modulePath);
        const defaultVersion = latestInfo?.Version ?? catalogEntry?.latestVersion;

        if (!defaultVersion) return null;

        const material = await this.loadVersionMaterial(modulePath, defaultVersion);
        if (!material) return null;

        const xp = this.moduleXPath(modulePath);
        const selfUrl = this.moduleBaseUrl(baseUrl, modulePath);
        const { moduleId } = this.moduleIdentity(modulePath);
        const allVersions = catalogEntry?.versions?.length
            ? catalogEntry.versions
            : await this.goService.listVersions(modulePath);

        return {
            [`${RESOURCE_TYPE_SINGULAR}id`]: moduleId,
            versionid: versionToId(material.version),
            isdefault: true,
            xid: xp,
            self: selfUrl,
            ancestor: xp,
            epoch: this.entityState.getEpoch(xp),
            ...this.entityTimestampFields(material.infoTime),
            name: modulePath,
            version: material.version,
            modulepath: modulePath,
            meta: this.buildMeta(modulePath, latestInfo?.Version, material.gomod),
            versionsurl: `${selfUrl}/versions`,
            versionscount: allVersions.length,
            info_url: this.goService.proxyUrl(modulePath, material.version, 'info'),
            mod_url: this.goService.proxyUrl(modulePath, material.version, 'mod'),
            zip_url: this.goService.proxyUrl(modulePath, material.version, 'zip'),
            ...(material.checksums?.gomodHash ? { gomod_hash: material.checksums.gomodHash } : {}),
            ...(material.checksums?.zipHash ? { zip_hash: material.checksums.zipHash } : {}),
            pseudo_version: isPseudoVersion(material.version),
            pre_release: isPreRelease(material.version),
            incompatible: isIncompatibleVersion(material.version),
            ...(material.gomod?.goVersion ? { go_version: material.gomod.goVersion } : {}),
            ...(material.gomod?.toolchain ? { toolchain: material.gomod.toolchain } : {}),
            ...(material.gomod?.require?.length ? { require: material.gomod.require } : {}),
            ...(material.gomod?.replace?.length ? { replace: material.gomod.replace } : {}),
            ...(material.gomod?.exclude?.length ? { exclude: material.gomod.exclude } : {}),
            ...(material.gomod?.retract?.length ? { retract: material.gomod.retract } : {}),
            ...(material.gomod?.godebug && Object.keys(material.gomod.godebug).length ? { godebug: material.gomod.godebug } : {}),
            ...(material.gomod?.tool?.length ? { tool: material.gomod.tool } : {}),
            ...(material.gomod?.ignore?.length ? { ignore: material.gomod.ignore } : {}),
        } as ModuleRecord;
    }

    async getVersion(req: Request, modulePath: string, version: string): Promise<VersionRecord | null> {
        const catalogEntry = this.checkpoint.getModule(modulePath);
        const defaultVersion = (await this.goService.getLatest(modulePath))?.Version ?? catalogEntry?.latestVersion;
        const material = await this.loadVersionMaterial(modulePath, version);
        if (!material) return null;
        return this.buildVersionRecord(req, modulePath, material, defaultVersion);
    }

    async listVersions(
        req: Request,
        modulePath: string,
        offset: number,
        limit: number
    ): Promise<{ versions: VersionRecord[]; totalCount: number } | null> {
        const catalogEntry = this.checkpoint.getModule(modulePath);
        const allVersions = catalogEntry?.versions?.length
            ? [...catalogEntry.versions].sort()
            : await this.goService.listVersions(modulePath);

        if (allVersions.length === 0) return null;

        const page = allVersions.slice(offset, offset + limit);
        const records: VersionRecord[] = [];
        const defaultVersion = (await this.goService.getLatest(modulePath))?.Version ?? catalogEntry?.latestVersion;

        for (const version of page) {
            const material = await this.loadVersionMaterial(modulePath, version);
            if (!material) continue;
            records.push(this.buildVersionRecord(req, modulePath, material, defaultVersion));
        }

        return { versions: records, totalCount: allVersions.length };
    }
}
