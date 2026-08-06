import { type CratesGetResult, type CratesIoAuditAction, type CratesIoCrate, type CratesIoDependency, type CratesIoOwner, type CratesIoUser, type CratesIoVersion } from './adapter';
import {
  GROUP_TYPE,
  GROUP_TYPE_SINGULAR,
  REGISTRY_ID,
  REGISTRY_NAME,
  RESOURCE_TYPE,
  SPEC_VERSION
} from './model';

export interface XRegistryRoot {
  readonly registryid: string;
  readonly self: string;
  readonly xid: string;
  readonly epoch: number;
  readonly createdat: string;
  readonly modifiedat: string;
  readonly description: string;
  readonly specversion: string;
  readonly [key: string]: unknown;
}

export interface XRegistryGroup {
  readonly rustregistryid: string;
  readonly self: string;
  readonly xid: string;
  readonly epoch: number;
  readonly createdat: string;
  readonly modifiedat: string;
  readonly description: string;
  readonly [key: string]: unknown;
}

export interface XRegistryCrateMeta {
  readonly crateid: string;
  readonly self: string;
  readonly xid: string;
  readonly epoch: number;
  readonly createdat: string;
  readonly modifiedat: string;
  readonly readonly: boolean;
  readonly compatibility: 'none';
  readonly defaultversionid: string;
  readonly defaultversionurl: string;
  readonly defaultversionsticky: false;
  readonly [key: string]: unknown;
}

export interface XRegistryCrate {
  readonly crateid: string;
  readonly versionid: string;
  readonly self: string;
  readonly xid: string;
  readonly epoch: number;
  readonly createdat: string;
  readonly modifiedat: string;
  readonly ancestor: string;
  readonly name: string;
  readonly metaurl: string;
  readonly meta: XRegistryCrateMeta;
  readonly versionsurl: string;
  readonly versionscount: number;
  readonly [key: string]: unknown;
}

export interface XRegistryVersion {
  readonly crateid: string;
  readonly versionid: string;
  readonly self: string;
  readonly xid: string;
  readonly epoch: number;
  readonly createdat: string;
  readonly modifiedat: string;
  readonly ancestor: string;
  readonly name: string;
  readonly isdefault: boolean;
  readonly immutable: boolean;
  readonly [key: string]: unknown;
}

type RequestLike = { get(name: string): string | undefined; protocol: string };

function stableEpoch(dateString: string): number {
  const ms = Date.parse(dateString);
  return Number.isNaN(ms) ? 1 : Math.floor(ms / 1000);
}

function definedObject(entries: readonly (readonly [string, unknown])[]): Record<string, unknown> {
  const mapped: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    if (value === null || value === undefined) {
      continue;
    }
    if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value as Record<string, unknown>).length === 0) {
      continue;
    }
    mapped[key] = value;
  }
  return mapped;
}

function crateUrl(baseUrl: string, crateId: string): string {
  return `${baseUrl}/${GROUP_TYPE}/${REGISTRY_ID}/${RESOURCE_TYPE}/${encodeURIComponent(crateId)}`;
}

function versionUrl(baseUrl: string, crateId: string, versionId: string): string {
  return `${crateUrl(baseUrl, crateId)}/versions/${encodeURIComponent(versionId)}`;
}

function metaUrl(baseUrl: string, crateId: string): string {
  return `${crateUrl(baseUrl, crateId)}/meta`;
}

function mapActor(user: CratesIoUser | null | undefined): Record<string, unknown> | undefined {
  if (!user) {
    return undefined;
  }
  return definedObject([
    ['id', user.id],
    ['login', user.login],
    ['name', user.name],
    ['url', user.url],
    ['avatar', user.avatar]
  ]);
}

function mapOwners(owners: readonly CratesIoOwner[]): readonly Record<string, unknown>[] {
  return owners.map(owner => definedObject([
    ['id', owner.id],
    ['login', owner.login],
    ['name', owner.name],
    ['kind', owner.kind],
    ['url', owner.url],
    ['avatar', owner.avatar]
  ]));
}

function mapAuditActions(actions: readonly CratesIoAuditAction[]): readonly Record<string, unknown>[] {
  return actions.map(action => definedObject([
    ['action', action.action],
    ['time', action.time],
    ['user', mapActor(action.user)]
  ]));
}

function mapDependencies(dependencies: readonly CratesIoDependency[] | undefined): readonly Record<string, unknown>[] | undefined {
  if (!dependencies) {
    return undefined;
  }
  return dependencies.map(dep => definedObject([
    ['name', dep.name],
    ['req', dep.req],
    ['features', dep.features],
    ['optional', dep.optional],
    ['default_features', dep.default_features],
    ['target', dep.target],
    ['kind', dep.kind],
    ['registry', dep.registry],
    ['package', dep.package]
  ]));
}

function mapCrateLinks(crate: CratesIoCrate): Record<string, unknown> | undefined {
  const links = definedObject([
    ['version_downloads', crate.links.version_downloads],
    ['versions', crate.links.versions],
    ['owners', crate.links.owners],
    ['owner_team', crate.links.owner_team],
    ['owner_user', crate.links.owner_user],
    ['reverse_dependencies', crate.links.reverse_dependencies]
  ]);
  return Object.keys(links).length > 0 ? links : undefined;
}

function isPrerelease(version: string): boolean {
  const withoutBuild = version.split('+', 1)[0] ?? version;
  return withoutBuild.includes('-');
}

export function deriveVersionId(version: string): string {
  return version.replace(/\+/g, '~');
}

export function buildBaseUrl(req: RequestLike): string {
  const xBaseUrl = req.get('x-base-url');
  if (xBaseUrl) return xBaseUrl.replace(/\/$/, '');
  const forwardedProto = req.get('x-forwarded-proto');
  const forwardedHost = req.get('x-forwarded-host');
  const host = req.get('host') ?? 'localhost';
  const protocol = forwardedProto ?? req.protocol ?? 'http';
  return `${protocol}://${forwardedHost ?? host}`;
}

export function resolveDefaultVersion(crate: CratesIoCrate, versions: readonly CratesIoVersion[] = []): string {
  if (crate.default_version) {
    return crate.default_version;
  }
  const explicit = crate.max_stable_version ?? crate.max_version ?? crate.newest_version;
  if (explicit) {
    return explicit;
  }
  const nonYankedStable = versions.find(version => !version.yanked && !isPrerelease(version.num));
  if (nonYankedStable) {
    return nonYankedStable.num;
  }
  const nonYanked = versions.find(version => !version.yanked);
  if (nonYanked) {
    return nonYanked.num;
  }
  return versions[0]?.num ?? '';
}

function selectDefaultVersion(data: CratesGetResult): CratesIoVersion {
  const defaultNum = resolveDefaultVersion(data.crate, data.versions);
  const selected = data.versions.find(version => version.num === defaultNum) ?? data.versions[0];
  if (!selected) {
    throw new Error(`crate ${data.crate.name} has no versions to project`);
  }
  return selected;
}

function mapVersionFields(version: CratesIoVersion, crateFallback?: CratesIoCrate): Record<string, unknown> {
  return definedObject([
    ['name', version.crate],
    ['description', version.description ?? crateFallback?.description],
    ['documentation', version.documentation ?? crateFallback?.documentation],
    ['createdat', version.created_at],
    ['modifiedat', version.updated_at],
    ['ancestor', deriveVersionId(version.num)],
    ['num', version.num],
    ['homepage', version.homepage ?? crateFallback?.homepage],
    ['repository', version.repository ?? crateFallback?.repository],
    ['license', version.license],
    ['categories', crateFallback?.categories],
    ['keywords', crateFallback?.keywords],
    ['downloads', version.downloads],
    ['crate_size', version.crate_size],
    ['cksum', version.cksum ?? version.checksum],
    ['dl_path', version.dl_path],
    ['readme_path', version.readme_path],
    ['features', version.features],
    ['features2', version.features2],
    ['v', version.v],
    ['rust_version', version.rust_version],
    ['edition', version.edition],
    ['lib_links', version.lib_links],
    ['has_lib', version.has_lib],
    ['bin_names', version.bin_names],
    ['yanked', version.yanked],
    ['yank_message', version.yank_message],
    ['published_by', mapActor(version.published_by)],
    ['audit_actions', mapAuditActions(version.audit_actions)],
    ['dependencies', mapDependencies(version.dependencies)]
  ]);
}

export function mapRegistryRoot(baseUrl: string, groupsUrl: string): XRegistryRoot {
  return {
    registryid: REGISTRY_ID,
    self: baseUrl,
    xid: '/',
    epoch: 1,
    createdat: '2024-01-01T00:00:00.000Z',
    modifiedat: new Date().toISOString(),
    description: 'xRegistry-compliant proxy for crates.io (Rust package registry)',
    specversion: SPEC_VERSION,
    [`${GROUP_TYPE}url`]: groupsUrl,
    [`${GROUP_TYPE}count`]: 1
  };
}

export function mapGroup(baseUrl: string, sourceUrl: string): XRegistryGroup {
  const groupUrl = `${baseUrl}/${GROUP_TYPE}/${REGISTRY_ID}`;
  return {
    [`${GROUP_TYPE_SINGULAR}id`]: REGISTRY_ID,
    self: groupUrl,
    xid: `/${GROUP_TYPE}/${REGISTRY_ID}`,
    epoch: 1,
    createdat: '2024-01-01T00:00:00.000Z',
    modifiedat: new Date().toISOString(),
    name: REGISTRY_NAME,
    description: 'The crates.io Rust package registry projection',
    sourceurl: sourceUrl,
    [`${RESOURCE_TYPE}url`]: `${groupUrl}/${RESOURCE_TYPE}`
  };
}

export function mapCrateMeta(data: CratesGetResult, baseUrl: string): XRegistryCrateMeta {
  const defaultVersion = selectDefaultVersion(data);
  const defaultVersionId = deriveVersionId(defaultVersion.num);
  return {
    crateid: data.crate.name,
    self: metaUrl(baseUrl, data.crate.name),
    xid: `/${GROUP_TYPE}/${REGISTRY_ID}/${RESOURCE_TYPE}/${data.crate.name}/meta`,
    epoch: stableEpoch(data.crate.updated_at),
    createdat: data.crate.created_at,
    modifiedat: data.crate.updated_at,
    readonly: true,
    compatibility: 'none',
    defaultversionid: defaultVersionId,
    defaultversionurl: versionUrl(baseUrl, data.crate.name, defaultVersionId),
    defaultversionsticky: false,
    ...definedObject([
      ['default_version', data.crate.default_version],
      ['max_version', data.crate.max_version],
      ['max_stable_version', data.crate.max_stable_version],
      ['newest_version', data.crate.newest_version],
      ['num_versions', data.crate.num_versions ?? data.versions.length],
      ['downloads', data.crate.downloads],
      ['recent_downloads', data.crate.recent_downloads],
      ['yanked', data.crate.yanked ?? (data.versions.length > 0 && data.versions.every(version => version.yanked))],
      ['trustpub_only', data.crate.trustpub_only],
      ['owners', mapOwners(data.owners)],
      ['crate_links', mapCrateLinks(data.crate)]
    ])
  };
}

export function mapCrate(data: CratesGetResult, baseUrl: string): XRegistryCrate {
  const defaultVersion = selectDefaultVersion(data);
  const defaultVersionId = deriveVersionId(defaultVersion.num);
  const versionFields = mapVersionFields(defaultVersion, data.crate);
  const url = crateUrl(baseUrl, data.crate.name);
  return {
    crateid: data.crate.name,
    versionid: defaultVersionId,
    self: url,
    xid: `/${GROUP_TYPE}/${REGISTRY_ID}/${RESOURCE_TYPE}/${data.crate.name}`,
    epoch: stableEpoch(defaultVersion.updated_at),
    createdat: defaultVersion.created_at,
    modifiedat: defaultVersion.updated_at,
    ancestor: defaultVersionId,
    name: defaultVersion.crate,
    ...versionFields,
    metaurl: metaUrl(baseUrl, data.crate.name),
    meta: mapCrateMeta(data, baseUrl),
    versionsurl: `${url}/versions`,
    versionscount: data.crate.num_versions ?? data.versions.length
  };
}

export function mapVersion(version: CratesIoVersion, defaultVersion: string, baseUrl: string): XRegistryVersion {
  const versionId = deriveVersionId(version.num);
  const versionFields = mapVersionFields(version);
  return {
    crateid: version.crate,
    versionid: versionId,
    self: versionUrl(baseUrl, version.crate, versionId),
    xid: `/${GROUP_TYPE}/${REGISTRY_ID}/${RESOURCE_TYPE}/${version.crate}/versions/${versionId}`,
    epoch: stableEpoch(version.updated_at),
    createdat: version.created_at,
    modifiedat: version.updated_at,
    ancestor: versionId,
    name: version.crate,
    ...versionFields,
    isdefault: version.num === defaultVersion,
    immutable: true
  };
}
