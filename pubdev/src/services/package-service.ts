/**
 * Package Service — transforms pub.dev API responses into xRegistry-compliant shapes.
 */

import { UpstreamError } from '@xregistry/registry-core';
import { EntityStateManager } from '../../../shared/entity-state-manager';
import { REGISTRY_METADATA } from '../config/constants';
import type { PubDevPackageResponse, PubDevVersion } from '../types/pubdev';
import { PubDevService, compareVersions } from './pubdev-service';
import { decodePubDevVersionId, encodePubDevVersionId } from '../utils/version-id';

const { GROUP_TYPE, GROUP_ID, RESOURCE_TYPE, RESOURCE_TYPE_SINGULAR } = REGISTRY_METADATA;

function notFound(path: string, kind: string, id: string): never {
  throw new UpstreamError({
    code: 'not_found',
    message: `The ${kind} (${id}) was not found`,
    status: 404,
    details: { path },
  });
}

function repoString(repo: unknown): string {
  if (typeof repo === 'string') return repo;
  if (repo && typeof repo === 'object' && 'url' in repo && typeof (repo as Record<string, unknown>)['url'] === 'string') {
    return (repo as Record<string, string>)['url']!;
  }
  return '';
}

function buildDeps(deps: Record<string, unknown> | undefined): Array<{ name: string; constraint: string; package: string }> {
  if (!deps) return [];
  return Object.entries(deps).map(([name, constraint]) => ({
    name,
    constraint: typeof constraint === 'string'
      ? constraint
      : constraint && typeof constraint === 'object' && 'version' in constraint
        ? String((constraint as Record<string, unknown>)['version'])
        : 'any',
    package: `/${GROUP_TYPE}/${GROUP_ID}/${RESOURCE_TYPE}/${name}`,
  }));
}

export class PackageService {
  constructor(
    private readonly pubdev: PubDevService,
    private readonly entityState: EntityStateManager,
  ) {}

  private orderedVersions(pkg: PubDevPackageResponse): PubDevVersion[] {
    return [...(pkg.versions ?? [])].sort((a, b) =>
      compareVersions(a.version, b.version) ||
      encodePubDevVersionId(a.version).localeCompare(encodePubDevVersionId(b.version), undefined, { sensitivity: 'base' }) ||
      encodePubDevVersionId(a.version).localeCompare(encodePubDevVersionId(b.version)),
    );
  }

  async getPackageMetadata(name: string, baseUrl: string): Promise<Record<string, unknown>> {
    const pkg = await this.pubdev.fetchPackage(name);
    if (!pkg) notFound(`/${GROUP_TYPE}/${GROUP_ID}/${RESOURCE_TYPE}/${name}`, 'package', name);
    const sorted = this.orderedVersions(pkg);
    const selected = sorted.at(-1);
    if (!selected) notFound(`/${GROUP_TYPE}/${GROUP_ID}/${RESOURCE_TYPE}/${name}`, 'package', name);
    const defaultVersionId = encodePubDevVersionId(selected.version);
    const selectedIndex = sorted.length - 1;
    const ancestor = encodePubDevVersionId(selectedIndex > 0 ? sorted[selectedIndex - 1]!.version : selected.version);
    const versionPath = `/${GROUP_TYPE}/${GROUP_ID}/${RESOURCE_TYPE}/${name}/versions/${defaultVersionId}`;
    const resourcePath = `/${GROUP_TYPE}/${GROUP_ID}/${RESOURCE_TYPE}/${name}`;
    const resourceBase = `${baseUrl}${resourcePath}`;
    const projected = this.formatVersion(
      name,
      selected,
      selected.version,
      ancestor,
      versionPath,
      `${baseUrl}${versionPath}`,
    );
    return {
      ...projected,
      [`${RESOURCE_TYPE_SINGULAR}id`]: name,
      xid: resourcePath,
      self: resourceBase,
      metaurl: `${resourceBase}/meta`,
      versionsurl: `${resourceBase}/versions`,
      versionscount: sorted.length,
    };
  }

  async getPackageVersions(name: string, baseUrl: string): Promise<Record<string, unknown>> {
    const pkg = await this.pubdev.fetchPackage(name);
    if (!pkg) notFound(`/${GROUP_TYPE}/${GROUP_ID}/${RESOURCE_TYPE}/${name}`, 'package', name);
    const sorted = this.orderedVersions(pkg);
    const selected = sorted.at(-1)?.version;
    const versionsBase = `${baseUrl}/${GROUP_TYPE}/${GROUP_ID}/${RESOURCE_TYPE}/${name}/versions`;
    const entries: Record<string, unknown> = {};
    for (let index = 0; index < sorted.length; index += 1) {
      const version = sorted[index]!;
      const versionId = encodePubDevVersionId(version.version);
      const ancestor = encodePubDevVersionId(index > 0 ? sorted[index - 1]!.version : version.version);
      const versionPath = `/${GROUP_TYPE}/${GROUP_ID}/${RESOURCE_TYPE}/${name}/versions/${versionId}`;
      entries[versionId] = this.formatVersion(
        name,
        version,
        selected,
        ancestor,
        versionPath,
        `${versionsBase}/${encodeURIComponent(versionId)}`,
      );
    }
    return entries;
  }

  async getVersionDetails(name: string, versionId: string, baseUrl: string): Promise<Record<string, unknown>> {
    const pkg = await this.pubdev.fetchPackage(name);
    if (!pkg) notFound(`/${GROUP_TYPE}/${GROUP_ID}/${RESOURCE_TYPE}/${name}`, 'package', name);
    const rawVersion = decodePubDevVersionId(versionId);
    const version = rawVersion === null ? undefined : (pkg.versions ?? []).find(candidate => candidate.version === rawVersion);
    if (!version) notFound(`/${GROUP_TYPE}/${GROUP_ID}/${RESOURCE_TYPE}/${name}/versions/${versionId}`, 'version', versionId);
    const sorted = this.orderedVersions(pkg);
    const selected = sorted.at(-1)?.version;
    const index = sorted.findIndex(candidate => candidate.version === rawVersion);
    const ancestor = encodePubDevVersionId(index > 0 ? sorted[index - 1]!.version : version.version);
    const versionPath = `/${GROUP_TYPE}/${GROUP_ID}/${RESOURCE_TYPE}/${name}/versions/${versionId}`;
    return this.formatVersion(name, version, selected, ancestor, versionPath, `${baseUrl}${versionPath}`);
  }

  async getPackageMeta(name: string, baseUrl: string): Promise<Record<string, unknown>> {
    const pkg = await this.pubdev.fetchPackage(name);
    if (!pkg) notFound(`/${GROUP_TYPE}/${GROUP_ID}/${RESOURCE_TYPE}/${name}`, 'package', name);
    const sorted = this.orderedVersions(pkg);
    const selected = sorted.at(-1);
    if (!selected) notFound(`/${GROUP_TYPE}/${GROUP_ID}/${RESOURCE_TYPE}/${name}`, 'package', name);
    const selectedVersionId = encodePubDevVersionId(selected.version);
    const resourceBase = `${baseUrl}/${GROUP_TYPE}/${GROUP_ID}/${RESOURCE_TYPE}/${name}`;
    const metaPath = `/${GROUP_TYPE}/${GROUP_ID}/${RESOURCE_TYPE}/${name}/meta`;
    const [score, publisher] = await Promise.all([
      this.pubdev.fetchScore(name),
      this.pubdev.fetchPublisher(name),
    ]);
    return {
      [`${RESOURCE_TYPE_SINGULAR}id`]: name,
      xid: metaPath,
      self: `${resourceBase}/meta`,
      epoch: this.entityState.getEpoch(metaPath),
      createdat: this.entityState.getCreatedAt(metaPath),
      modifiedat: this.entityState.getModifiedAt(metaPath),
      readonly: true,
      compatibility: 'none',
      defaultversionid: selectedVersionId,
      defaultversionurl: `${resourceBase}/versions/${encodeURIComponent(selectedVersionId)}`,
      defaultversionsticky: false,
      ...(publisher?.publisherId !== undefined ? { publisher: publisher.publisherId } : {}),
      ...(score ? {
        likes: score.likeCount,
        pub_points: score.grantedPoints,
        popularity: score.popularityScore,
      } : {}),
    };
  }

  private formatVersion(
    packageName: string,
    version: PubDevVersion,
    selectedVersion: string | undefined,
    ancestor: string,
    versionPath: string,
    versionUrl: string,
  ): Record<string, unknown> {
    const pubspec = version.pubspec ?? {};
    return {
      versionid: encodePubDevVersionId(version.version),
      version: version.version,
      xid: versionPath,
      self: versionUrl,
      [`${RESOURCE_TYPE_SINGULAR}id`]: packageName,
      name: pubspec.name ?? packageName,
      description: pubspec.description ?? '',
      epoch: this.entityState.getEpoch(versionPath),
      createdat: version.published ?? this.entityState.getCreatedAt(versionPath),
      modifiedat: version.published ?? this.entityState.getModifiedAt(versionPath),
      isdefault: version.version === selectedVersion,
      ancestor,
      contenttype: 'application/zip',
      homepage: typeof pubspec.homepage === 'string' ? pubspec.homepage : '',
      repository: repoString(pubspec.repository),
      issue_tracker: typeof pubspec.issue_tracker === 'string' ? pubspec.issue_tracker : '',
      documentation: typeof pubspec.documentation === 'string' ? pubspec.documentation : '',
      sdk_constraint: pubspec.environment?.sdk ?? '',
      flutter_constraint: pubspec.environment?.flutter ?? '',
      keywords: pubspec.topics ?? [],
      platforms: pubspec.platforms ? Object.keys(pubspec.platforms) : [],
      dependencies: buildDeps(pubspec.dependencies),
      dev_dependencies: buildDeps(pubspec.dev_dependencies),
      package: `/${GROUP_TYPE}/${GROUP_ID}/${RESOURCE_TYPE}/${packageName}`,
      retracted: version.retracted ?? false,
      pubspec,
      ...(typeof pubspec.license === 'string' ? { license: pubspec.license } : {}),
      ...(version.published !== undefined ? { published: version.published } : {}),
      ...(version.archive_url !== undefined ? { archive_url: version.archive_url } : {}),
      ...(version.archive_sha256 !== undefined ? { archive_sha256: version.archive_sha256 } : {}),
    };
  }
}
