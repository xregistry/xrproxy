import { type CratesIoCrate, type CratesIoVersion, type CratesIoDependency } from './adapter';
import {
  GROUP_TYPE,
  GROUP_TYPE_SINGULAR,
  REGISTRY_ID,
  REGISTRY_NAME,
  RESOURCE_TYPE,
  RESOURCE_TYPE_SINGULAR,
  SCHEMA_VERSION,
  SPEC_VERSION
} from './model';

/** xRegistry registry root document */
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

/** xRegistry group document (one rustregistry) */
export interface XRegistryGroup {
  readonly groupid?: string;
  readonly self: string;
  readonly xid: string;
  readonly epoch: number;
  readonly createdat: string;
  readonly modifiedat: string;
  readonly description: string;
  readonly [key: string]: unknown;
}

/** xRegistry resource document (one crate) */
export interface XRegistryCrate {
  readonly crateid: string;
  readonly self: string;
  readonly xid: string;
  readonly epoch: number;
  readonly createdat: string;
  readonly modifiedat: string;
  readonly name: string;
  readonly description: string | null;
  readonly homepage: string | null;
  readonly repository: string | null;
  readonly documentation: string | null;
  readonly categories: readonly string[] | null;
  readonly keywords: readonly string[] | null;
  readonly downloads: number;
  readonly recent_downloads: number | null;
  readonly max_version: string;
  readonly max_stable_version: string | null;
  readonly newest_version: string;
  readonly yanked: boolean | null;
  readonly license: string | null;
  readonly links: Readonly<Record<string, string | null>>;
  readonly [key: string]: unknown;
}

/** xRegistry version document (one crate version) */
export interface XRegistryVersion {
  readonly versionid: string;
  readonly self: string;
  readonly xid: string;
  readonly epoch: number;
  readonly createdat: string;
  readonly modifiedat: string;
  readonly isdefault: boolean;
  readonly immutable: boolean;
  readonly yanked: boolean;
  readonly license: string | null;
  readonly downloads: number;
  readonly crate_size: number | null;
  readonly features: Readonly<Record<string, readonly string[]>>;
  readonly published_by: string | null;
  readonly [key: string]: unknown;
}

function stableEpoch(dateString: string): number {
  const ms = Date.parse(dateString);
  return Number.isNaN(ms) ? 1 : Math.floor(ms / 1000);
}

export function buildBaseUrl(req: { get(name: string): string | undefined; protocol: string }): string {
  const xBaseUrl = req.get('x-base-url');
  if (xBaseUrl) return xBaseUrl.replace(/\/$/, '');
  const forwardedProto = req.get('x-forwarded-proto');
  const forwardedHost = req.get('x-forwarded-host');
  const host = req.get('host') ?? 'localhost';
  const protocol = forwardedProto ?? req.protocol ?? 'http';
  return `${protocol}://${forwardedHost ?? host}`;
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
    [`${GROUP_TYPE}url`]: groupsUrl
  };
}

export function mapGroup(baseUrl: string): XRegistryGroup {
  const groupUrl = `${baseUrl}/${GROUP_TYPE}/${REGISTRY_ID}`;
  return {
    [`${GROUP_TYPE_SINGULAR}id`]: REGISTRY_ID,
    self: groupUrl,
    xid: `/${GROUP_TYPE}/${REGISTRY_ID}`,
    epoch: 1,
    createdat: '2024-01-01T00:00:00.000Z',
    modifiedat: new Date().toISOString(),
    description: 'The crates.io Rust package registry',
    [`${RESOURCE_TYPE}url`]: `${groupUrl}/${RESOURCE_TYPE}`,
    schema: SCHEMA_VERSION
  };
}

export function mapCrate(crate: CratesIoCrate, baseUrl: string): XRegistryCrate {
  const crateUrl = `${baseUrl}/${GROUP_TYPE}/${REGISTRY_ID}/${RESOURCE_TYPE}/${encodeURIComponent(crate.name)}`;
  return {
    crateid: crate.name,
    self: crateUrl,
    xid: `/${GROUP_TYPE}/${REGISTRY_ID}/${RESOURCE_TYPE}/${crate.name}`,
    epoch: stableEpoch(crate.updated_at),
    createdat: crate.created_at,
    modifiedat: crate.updated_at,
    name: crate.name,
    description: crate.description,
    homepage: crate.homepage,
    repository: crate.repository,
    documentation: crate.documentation,
    categories: crate.categories,
    keywords: crate.keywords,
    downloads: crate.downloads,
    recent_downloads: crate.recent_downloads,
    max_version: crate.max_version,
    max_stable_version: crate.max_stable_version,
    newest_version: crate.newest_version,
    yanked: crate.yanked,
    license: crate.license,
    links: crate.links,
    versionsurl: `${crateUrl}/versions`,
    schema: SCHEMA_VERSION
  };
}

export function mapVersion(
  version: CratesIoVersion,
  maxStableVersion: string | null,
  baseUrl: string
): XRegistryVersion {
  const versionUrl = `${baseUrl}/${GROUP_TYPE}/${REGISTRY_ID}/${RESOURCE_TYPE}/${encodeURIComponent(version.crate)}/versions/${encodeURIComponent(version.num)}`;
  return {
    versionid: version.num,
    self: versionUrl,
    xid: `/${GROUP_TYPE}/${REGISTRY_ID}/${RESOURCE_TYPE}/${version.crate}/versions/${version.num}`,
    epoch: stableEpoch(version.updated_at),
    createdat: version.created_at,
    modifiedat: version.updated_at,
    isdefault: version.num === (maxStableVersion ?? ''),
    immutable: true,
    yanked: version.yanked,
    license: version.license,
    downloads: version.downloads,
    crate_size: version.crate_size,
    features: version.features,
    published_by: version.published_by?.login ?? null,
    schema: SCHEMA_VERSION
  };
}

export function mapDependency(dep: CratesIoDependency): {
  readonly crate: string;
  readonly requirement: string;
  readonly optional: boolean;
  readonly default_features: boolean;
  readonly features: readonly string[];
  readonly target: string | null;
  readonly kind: string;
} {
  return {
    crate: dep.crate_id,
    requirement: dep.req,
    optional: dep.optional,
    default_features: dep.default_features,
    features: dep.features,
    target: dep.target,
    kind: dep.kind
  };
}
