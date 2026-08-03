/**
 * Package Service — transforms pub.dev API responses into xRegistry-compliant shapes.
 */

import { UpstreamError } from '@xregistry/registry-core';
import { EntityStateManager } from '../../../shared/entity-state-manager';
import { normalizeSourceUrl, REGISTRY_METADATA } from '../config/constants';
import type { PubDevPackageResponse, PubDevScore, PubDevVersion, Pubspec } from '../types/pubdev';
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function repoString(repo: unknown): string | undefined {
  if (typeof repo === 'string' && repo.length > 0) return repo;
  if (isPlainObject(repo) && typeof repo['url'] === 'string' && repo['url'].length > 0) {
    return repo['url'];
  }
  return undefined;
}

function projectStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string');
}

function projectEnvironment(environment: Pubspec['environment']): Record<string, string> | undefined {
  if (!isPlainObject(environment)) return undefined;
  return Object.fromEntries(
    Object.entries(environment).filter(([, constraint]) => typeof constraint === 'string'),
  ) as Record<string, string>;
}

function projectDeclaredPlatforms(platforms: Pubspec['platforms']): Record<string, unknown> | undefined {
  if (!isPlainObject(platforms)) return undefined;
  return Object.fromEntries(Object.entries(platforms).filter(([, value]) => value !== undefined));
}

function sameRegistryUrl(left: string, right: string): boolean {
  return normalizeSourceUrl(left) === normalizeSourceUrl(right);
}

function projectDependency(
  dependencyName: string,
  value: unknown,
  upstreamBase: string,
): Record<string, unknown> | undefined {
  if (typeof value === 'string') {
    return {
      source: 'hosted',
      constraint: value,
      package: `/${GROUP_TYPE}/${GROUP_ID}/${RESOURCE_TYPE}/${dependencyName}`,
    };
  }

  if (!isPlainObject(value)) return undefined;

  if (typeof value['sdk'] === 'string') {
    return {
      source: 'sdk',
      sdk: value['sdk'],
      ...(typeof value['version'] === 'string' ? { constraint: value['version'] } : {}),
    };
  }

  if (Object.hasOwn(value, 'git')) {
    const git = value['git'];
    if (typeof git === 'string') {
      return { source: 'git', git_url: git };
    }
    if (isPlainObject(git)) {
      const dependency: Record<string, unknown> = { source: 'git' };
      if (typeof git['url'] === 'string') dependency['git_url'] = git['url'];
      if (typeof git['ref'] === 'string') dependency['git_ref'] = git['ref'];
      if (typeof git['path'] === 'string') dependency['git_path'] = git['path'];
      return dependency;
    }
    return { source: 'git' };
  }

  if (typeof value['path'] === 'string') {
    return { source: 'path', path: value['path'] };
  }

  if (!Object.hasOwn(value, 'version') && !Object.hasOwn(value, 'hosted')) {
    return undefined;
  }

  const dependency: Record<string, unknown> = { source: 'hosted' };
  if (typeof value['version'] === 'string') dependency['constraint'] = value['version'];

  let hostedUrl: string | undefined;
  let hostedName: string | undefined;
  const hosted = value['hosted'];
  if (typeof hosted === 'string') {
    hostedUrl = hosted;
  } else if (isPlainObject(hosted)) {
    hostedUrl = stringValue(hosted['url']);
    hostedName = stringValue(hosted['name']);
  }

  if (hostedName && hostedName !== dependencyName) {
    dependency['hosted_name'] = hostedName;
  }

  if (hostedUrl && !sameRegistryUrl(hostedUrl, upstreamBase)) {
    dependency['hosted_url'] = hostedUrl;
  } else {
    const packageName = hostedName ?? dependencyName;
    dependency['package'] = `/${GROUP_TYPE}/${GROUP_ID}/${RESOURCE_TYPE}/${packageName}`;
  }

  return dependency;
}

function projectDependencyMap(
  dependencies: Record<string, unknown> | undefined,
  upstreamBase: string,
): Record<string, Record<string, unknown>> | undefined {
  if (!isPlainObject(dependencies)) return undefined;
  return Object.fromEntries(
    Object.entries(dependencies)
      .map(([name, value]) => [name, projectDependency(name, value, upstreamBase)] as const)
      .filter(([, value]) => value !== undefined),
  ) as Record<string, Record<string, unknown>>;
}

function projectScoreMeta(score: PubDevScore | null): Record<string, unknown> {
  if (!score) return {};

  const projected: Record<string, unknown> = {};
  if (Number.isInteger(score.likeCount)) projected['likes'] = score.likeCount;
  if (Number.isInteger(score.grantedPoints) && Number.isInteger(score.maxPoints)) {
    projected['pub_points'] = score.grantedPoints;
    projected['max_points'] = score.maxPoints;
  }
  if (Number.isInteger(score.downloadCount30Days)) {
    projected['download_count_30_days'] = score.downloadCount30Days;
  }
  if (Array.isArray(score.tags)) {
    const tags = score.tags.filter((tag): tag is string => typeof tag === 'string');
    projected['tags'] = tags;

    const licenses = Array.from(new Set(
      tags
        .filter(tag => tag.startsWith('license:'))
        .map(tag => tag.slice('license:'.length).toLowerCase())
        .filter(tag => tag.length > 0),
    ));
    if (licenses.length > 0) projected['license'] = licenses;

    const detectedPlatforms = Array.from(new Set(
      tags
        .filter(tag => tag.startsWith('platform:'))
        .map(tag => tag.slice('platform:'.length))
        .filter(tag => tag.length > 0),
    ));
    if (detectedPlatforms.length > 0) projected['detected_platforms'] = detectedPlatforms;
  }

  return projected;
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

  private selectDefaultVersion(pkg: PubDevPackageResponse, sorted: PubDevVersion[]): PubDevVersion | undefined {
    const upstreamLatestVersion = stringValue(pkg.latest?.version);
    const latestMatch = upstreamLatestVersion
      ? sorted.find(candidate => candidate.version === upstreamLatestVersion) ?? pkg.latest
      : undefined;

    if (latestMatch && latestMatch.retracted !== true) {
      return latestMatch;
    }

    const highestSelectable = [...sorted].reverse().find(candidate => candidate.retracted !== true);
    return highestSelectable ?? latestMatch ?? sorted.at(-1);
  }

  async getPackageMetadata(name: string, baseUrl: string): Promise<Record<string, unknown>> {
    const pkg = await this.pubdev.fetchPackage(name);
    if (!pkg) notFound(`/${GROUP_TYPE}/${GROUP_ID}/${RESOURCE_TYPE}/${name}`, 'package', name);

    const sorted = this.orderedVersions(pkg);
    const selected = this.selectDefaultVersion(pkg, sorted);
    if (!selected) notFound(`/${GROUP_TYPE}/${GROUP_ID}/${RESOURCE_TYPE}/${name}`, 'package', name);

    const defaultVersionId = encodePubDevVersionId(selected.version);
    const selectedIndex = sorted.findIndex(candidate => candidate.version === selected.version);
    const ancestor = encodePubDevVersionId(selectedIndex > 0 ? sorted[selectedIndex - 1]!.version : selected.version);
    const versionPath = `/${GROUP_TYPE}/${GROUP_ID}/${RESOURCE_TYPE}/${name}/versions/${defaultVersionId}`;
    const resourcePath = `/${GROUP_TYPE}/${GROUP_ID}/${RESOURCE_TYPE}/${name}`;
    const resourceBase = `${baseUrl}${resourcePath}`;
    const projected = this.formatVersion(name, selected, selected.version, ancestor, versionPath, `${baseUrl}${versionPath}`);

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
    const selected = this.selectDefaultVersion(pkg, sorted)?.version;
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
    const selected = this.selectDefaultVersion(pkg, sorted)?.version;
    const index = sorted.findIndex(candidate => candidate.version === rawVersion);
    const ancestor = encodePubDevVersionId(index > 0 ? sorted[index - 1]!.version : version.version);
    const versionPath = `/${GROUP_TYPE}/${GROUP_ID}/${RESOURCE_TYPE}/${name}/versions/${versionId}`;
    return this.formatVersion(name, version, selected, ancestor, versionPath, `${baseUrl}${versionPath}`);
  }

  async getPackageMeta(name: string, baseUrl: string): Promise<Record<string, unknown>> {
    const pkg = await this.pubdev.fetchPackage(name);
    if (!pkg) notFound(`/${GROUP_TYPE}/${GROUP_ID}/${RESOURCE_TYPE}/${name}`, 'package', name);

    const sorted = this.orderedVersions(pkg);
    const selected = this.selectDefaultVersion(pkg, sorted);
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
      ...(typeof pkg.isDiscontinued === 'boolean' ? { is_discontinued: pkg.isDiscontinued } : {}),
      ...(pkg.isDiscontinued === true && typeof pkg.replacedBy === 'string' ? { replaced_by: pkg.replacedBy } : {}),
      ...(typeof pkg.advisoriesUpdated === 'string' ? { advisories_updated: pkg.advisoriesUpdated } : {}),
      ...(typeof publisher?.publisherId === 'string' && publisher.publisherId.length > 0 ? { publisher: publisher.publisherId } : {}),
      ...projectScoreMeta(score),
    };
  }

  private formatVersion(
    packageName: string,
    version: PubDevVersion,
    defaultVersion: string | undefined,
    ancestor: string,
    versionPath: string,
    versionUrl: string,
  ): Record<string, unknown> {
    const observedAt = this.entityState.getCreatedAt(versionPath);
    const modifiedAt = this.entityState.getModifiedAt(versionPath);
    const pubspec = version.pubspec ?? ({ name: packageName } as Pubspec);
    const environment = projectEnvironment(pubspec.environment);
    const topics = projectStringArray(pubspec.topics);
    const declaredPlatforms = projectDeclaredPlatforms(pubspec.platforms);
    const dependencies = projectDependencyMap(pubspec.dependencies, this.pubdev.getUpstreamBase());
    const devDependencies = projectDependencyMap(pubspec.dev_dependencies, this.pubdev.getUpstreamBase());
    const dependencyOverrides = projectDependencyMap(pubspec.dependency_overrides, this.pubdev.getUpstreamBase());
    const repository = repoString(pubspec.repository);

    return {
      versionid: encodePubDevVersionId(version.version),
      version: version.version,
      xid: versionPath,
      self: versionUrl,
      [`${RESOURCE_TYPE_SINGULAR}id`]: packageName,
      name: pubspec.name ?? packageName,
      epoch: this.entityState.getEpoch(versionPath),
      createdat: version.published ?? observedAt,
      modifiedat: version.published ?? modifiedAt,
      isdefault: version.version === defaultVersion,
      ancestor,
      ...(typeof pubspec.description === 'string' ? { description: pubspec.description } : {}),
      ...(typeof pubspec.documentation === 'string' ? { documentation: pubspec.documentation } : {}),
      ...(typeof pubspec.homepage === 'string' ? { homepage: pubspec.homepage } : {}),
      ...(repository ? { repository } : {}),
      ...(typeof pubspec.issue_tracker === 'string' ? { issue_tracker: pubspec.issue_tracker } : {}),
      ...(topics !== undefined ? { topics } : {}),
      ...(environment !== undefined ? { environment } : {}),
      ...(environment?.sdk ? { sdk_constraint: environment.sdk } : {}),
      ...(environment?.flutter ? { flutter_constraint: environment.flutter } : {}),
      ...(declaredPlatforms !== undefined ? { declared_platforms: declaredPlatforms } : {}),
      ...(typeof version.retracted === 'boolean' ? { retracted: version.retracted } : {}),
      ...(typeof version.published === 'string' ? { published: version.published } : {}),
      ...(typeof version.archive_url === 'string' ? { archive_url: version.archive_url } : {}),
      ...(typeof version.archive_sha256 === 'string' ? { archive_sha256: version.archive_sha256 } : {}),
      ...(version.pubspec !== undefined ? { pubspec: version.pubspec } : {}),
      ...(dependencies !== undefined ? { dependencies } : {}),
      ...(devDependencies !== undefined ? { dev_dependencies: devDependencies } : {}),
      ...(dependencyOverrides !== undefined ? { dependency_overrides: dependencyOverrides } : {}),
      package: `/${GROUP_TYPE}/${GROUP_ID}/${RESOURCE_TYPE}/${packageName}`,
    };
  }
}
