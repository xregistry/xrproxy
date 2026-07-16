/**
 * Package Service — transforms pub.dev API responses into xRegistry-compliant shapes
 */

import { UpstreamError } from '@xregistry/registry-core';
import { EntityStateManager } from '../../../shared/entity-state-manager';
import { REGISTRY_METADATA } from '../config/constants';
import type { PubDevVersion } from '../types/pubdev';
import { PubDevService, compareVersions } from './pubdev-service';

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
  if (repo && typeof repo === 'object' && 'url' in repo && typeof (repo as Record<string,unknown>)['url'] === 'string') {
    return (repo as Record<string,string>)['url']!;
  }
  return '';
}

function buildDeps(deps: Record<string, unknown> | undefined): Array<{ name: string; constraint: string; package: string }> {
  if (!deps) return [];
  return Object.entries(deps).map(([name, c]) => ({
    name,
    constraint: typeof c === 'string' ? c : (c && typeof c === 'object' && 'version' in c) ? String((c as Record<string,unknown>)['version']) : 'any',
    package: `/${GROUP_TYPE}/${GROUP_ID}/${RESOURCE_TYPE}/${name}`,
  }));
}

export class PackageService {
  constructor(
    private readonly pubdev: PubDevService,
    private readonly entityState: EntityStateManager,
  ) {}

  async getPackageMetadata(name: string, baseUrl: string): Promise<Record<string, unknown>> {
    const pkg = await this.pubdev.fetchPackage(name);
    if (!pkg) notFound(`/${GROUP_TYPE}/${GROUP_ID}/${RESOURCE_TYPE}/${name}`, 'package', name);

    const latest = pkg.latest;
    const pubspec = latest?.pubspec ?? {};
    const versionCount = (pkg.versions ?? []).length;
    const resourceBase = `${baseUrl}/${GROUP_TYPE}/${GROUP_ID}/${RESOURCE_TYPE}/${name}`;
    const resourcePath = `/${GROUP_TYPE}/${GROUP_ID}/${RESOURCE_TYPE}/${name}`;

    const [score, publisher] = await Promise.all([
      this.pubdev.fetchScore(name),
      this.pubdev.fetchPublisher(name),
    ]);

    return {
      [`${RESOURCE_TYPE_SINGULAR}id`]: name,
      xid:           resourcePath,
      name:          pubspec.name ?? name,
      description:   pubspec.description ?? '',
      epoch:         this.entityState.getEpoch(resourcePath),
      createdat:     this.entityState.getCreatedAt(resourcePath),
      modifiedat:    this.entityState.getModifiedAt(resourcePath),
      self:          resourceBase,
      versionid:     latest?.version ?? '',
      isdefault:     true,
      metaurl:       `${resourceBase}/meta`,
      versionsurl:   `${resourceBase}/versions`,
      versionscount: versionCount,
      homepage:      pubspec.homepage ?? '',
      repository:    repoString(pubspec.repository),
      issue_tracker: typeof pubspec.issue_tracker === 'string' ? pubspec.issue_tracker : '',
      documentation: typeof pubspec.documentation === 'string' ? pubspec.documentation : '',
      publisher:     publisher?.publisherId ?? null,
      sdk_constraint: pubspec.environment?.sdk ?? '',
      flutter_constraint: pubspec.environment?.flutter ?? '',
      keywords:      pubspec.topics ?? [],
      platforms:     pubspec.platforms ? Object.keys(pubspec.platforms) : [],
      retracted:     pkg.isDiscontinued ?? false,
      dependencies:     buildDeps(pubspec.dependencies),
      dev_dependencies: buildDeps(pubspec.dev_dependencies),
      ...(score ? { likes: score.likeCount, pub_points: score.grantedPoints, popularity: score.popularityScore } : {}),
    };
  }

  async getPackageVersions(name: string, baseUrl: string): Promise<Record<string, unknown>> {
    const pkg = await this.pubdev.fetchPackage(name);
    if (!pkg) notFound(`/${GROUP_TYPE}/${GROUP_ID}/${RESOURCE_TYPE}/${name}`, 'package', name);

    const sorted = [...(pkg.versions ?? [])].sort((a, b) => compareVersions(a.version, b.version));
    const latestStable = pkg.latest?.version ?? sorted.at(-1)?.version;
    const versionsBase = `${baseUrl}/${GROUP_TYPE}/${GROUP_ID}/${RESOURCE_TYPE}/${name}/versions`;

    const entries: Record<string, unknown> = {};
    for (let i = 0; i < sorted.length; i++) {
      const v = sorted[i]!;
      const vPath = `/${GROUP_TYPE}/${GROUP_ID}/${RESOURCE_TYPE}/${name}/versions/${v.version}`;
      const ancestor = i > 0 ? sorted[i - 1]!.version : v.version;
      entries[v.version] = this.formatVersion(name, v, latestStable, ancestor, vPath, `${versionsBase}/${v.version}`);
    }
    return entries;
  }

  async getVersionDetails(name: string, versionId: string, baseUrl: string): Promise<Record<string, unknown>> {
    const pkg = await this.pubdev.fetchPackage(name);
    if (!pkg) notFound(`/${GROUP_TYPE}/${GROUP_ID}/${RESOURCE_TYPE}/${name}`, 'package', name);

    const v = (pkg.versions ?? []).find(x => x.version === versionId);
    if (!v) notFound(`/${GROUP_TYPE}/${GROUP_ID}/${RESOURCE_TYPE}/${name}/versions/${versionId}`, 'version', versionId);

    const sorted = [...(pkg.versions ?? [])].sort((a, b) => compareVersions(a.version, b.version));
    const latestStable = pkg.latest?.version ?? sorted.at(-1)?.version;
    const idx = sorted.findIndex(x => x.version === versionId);
    const ancestor = idx > 0 ? sorted[idx - 1]!.version : versionId;
    const vPath = `/${GROUP_TYPE}/${GROUP_ID}/${RESOURCE_TYPE}/${name}/versions/${versionId}`;

    return this.formatVersion(name, v, latestStable, ancestor, vPath, `${baseUrl}${vPath}`);
  }

  async getPackageMeta(name: string, baseUrl: string): Promise<Record<string, unknown>> {
    const pkg = await this.pubdev.fetchPackage(name);
    if (!pkg) notFound(`/${GROUP_TYPE}/${GROUP_ID}/${RESOURCE_TYPE}/${name}`, 'package', name);

    const latestVersion = pkg.latest?.version ?? '';
    const resourceBase = `${baseUrl}/${GROUP_TYPE}/${GROUP_ID}/${RESOURCE_TYPE}/${name}`;
    const metaPath = `/${GROUP_TYPE}/${GROUP_ID}/${RESOURCE_TYPE}/${name}/meta`;

    return {
      [`${RESOURCE_TYPE_SINGULAR}id`]: name,
      xid:        metaPath,
      self:       `${resourceBase}/meta`,
      epoch:      this.entityState.getEpoch(metaPath),
      createdat:  this.entityState.getCreatedAt(metaPath),
      modifiedat: this.entityState.getModifiedAt(metaPath),
      readonly:   true,
      compatibility: 'none',
      defaultversionid:  latestVersion,
      defaultversionurl: `${resourceBase}/versions/${latestVersion}`,
      defaultversionsticky: true,
    };
  }

  private formatVersion(
    pkgName: string,
    v: PubDevVersion,
    latestStable: string | undefined,
    ancestor: string,
    vPath: string,
    vUrl: string,
  ): Record<string, unknown> {
    const pubspec = v.pubspec ?? {};
    return {
      versionid:  v.version,
      xid:        vPath,
      name:       v.version,
      epoch:      this.entityState.getEpoch(vPath),
      createdat:  v.published ?? this.entityState.getCreatedAt(vPath),
      modifiedat: v.published ?? this.entityState.getModifiedAt(vPath),
      self:       vUrl,
      [`${RESOURCE_TYPE_SINGULAR}id`]: pkgName,
      isdefault:  v.version === latestStable,
      ancestor,
      contenttype:    'application/zip',
      published:      v.published ?? null,
      archive_url:    v.archive_url ?? null,
      archive_sha256: v.archive_sha256 ?? null,
      sdk_constraint:    pubspec.environment?.sdk ?? '',
      flutter_constraint: pubspec.environment?.flutter ?? '',
      retracted: v.retracted ?? false,
      pubspec:   pubspec,
    };
  }
}
