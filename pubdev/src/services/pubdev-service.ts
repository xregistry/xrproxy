/**
 * pub.dev API adapter built on HttpUpstreamClient + TtlCache
 * Replaces all ad-hoc axios/cache code.
 */

import {
  HttpUpstreamClient,
  TtlCache,
  type CacheStore,
  createCacheKey,
  type CachePolicy,
  isUpstreamError,
} from '@xregistry/registry-core';
import { PUBDEV_PATHS } from '../config/constants';
import type {
  PubDevPackageNamesResponse,
  PubDevPackageResponse,
  PubDevPublisher,
  PubDevScore,
  PubDevVersion,
} from '../types/pubdev';

const USER_AGENT = 'xregistry-pubdev-wrapper/1.0 (https://github.com/xregistry/xrproxy)';

export class PubDevService {
  private readonly client: HttpUpstreamClient;
  private readonly cache: TtlCache;
  private readonly upstreamBase: string;

  constructor(
    upstreamBase: string,
    store: CacheStore,
    policy: CachePolicy,
    clientOptions?: ConstructorParameters<typeof HttpUpstreamClient>[0],
  ) {
    this.upstreamBase = upstreamBase.replace(/\/$/, '');
    this.client = new HttpUpstreamClient({
      timeoutMs: 10_000,
      operationTimeoutMs: 30_000,
      maxAttempts: 3,
      ...clientOptions,
    });
    this.cache = new TtlCache(store, policy);
  }

  // ── Low-level GET ─────────────────────────────────────────────────────────

  private async get<T>(path: string, key: string): Promise<T | null> {
    const result = await this.cache.get<T>(key, async ctx => {
      const url = `${this.upstreamBase}${path}`;
      const response = await this.client.getJson<T>(url, {
        headers: { 'User-Agent': USER_AGENT },
        conditional: ctx.etag ? { etag: ctx.etag } : undefined,
      });
      if ('notModified' in response) {
        return { kind: 'not-modified', etag: response.etag };
      }
      return { kind: 'value', value: response.value, etag: response.etag };
    });
    return result.kind === 'value' ? (result.value as T) : null;
  }

  // ── pub.dev API calls ─────────────────────────────────────────────────────

  /**
   * GET /api/package-names — returns ALL package names (authoritative list)
   */
  async fetchPackageNames(): Promise<string[]> {
    const key = createCacheKey('package-names');
    const data = await this.get<PubDevPackageNamesResponse>(PUBDEV_PATHS.PACKAGE_NAMES, key);
    return (data?.packages ?? []).slice().sort((a, b) => a.localeCompare(b));
  }

  /**
   * GET /api/packages/{name}
   */
  async fetchPackage(name: string): Promise<PubDevPackageResponse | null> {
    const key = createCacheKey('package', name);
    return this.get<PubDevPackageResponse>(PUBDEV_PATHS.PACKAGE(name), key);
  }

  /**
   * GET /api/packages/{name}/score  (best-effort, returns null on error)
   */
  async fetchScore(name: string): Promise<PubDevScore | null> {
    try {
      const key = createCacheKey('score', name);
      return await this.get<PubDevScore>(PUBDEV_PATHS.SCORE(name), key);
    } catch {
      return null;
    }
  }

  /**
   * GET /api/packages/{name}/publisher  (best-effort)
   */
  async fetchPublisher(name: string): Promise<PubDevPublisher | null> {
    try {
      const key = createCacheKey('publisher', name);
      return await this.get<PubDevPublisher>(PUBDEV_PATHS.PUBLISHER(name), key);
    } catch {
      return null;
    }
  }

  /**
   * Return true when the package exists (non-404 response)
   */
  async packageExists(name: string): Promise<boolean> {
    try {
      const pkg = await this.fetchPackage(name);
      return pkg !== null;
    } catch (err) {
      if (isUpstreamError(err) && err.code === 'not_found') return false;
      return false;
    }
  }

  /**
   * Return version list sorted oldest-first
   */
  async getVersions(name: string): Promise<string[]> {
    const pkg = await this.fetchPackage(name);
    if (!pkg) return [];
    return (pkg.versions ?? [])
      .map(v => v.version)
      .sort(compareVersions);
  }

  /**
   * Find a specific version object by version string
   */
  async getVersion(name: string, version: string): Promise<PubDevVersion | null> {
    const pkg = await this.fetchPackage(name);
    return pkg?.versions?.find(v => v.version === version) ?? null;
  }
}

// ── Semver comparison ────────────────────────────────────────────────────────

/**
 * Compare two pub.dev semver strings, oldest first.
 *
 * Implements pub_semver precedence:
 *   1. Release triple (numeric)
 *   2. Prerelease < release (prerelease string present ↔ lower precedence)
 *   3. Prerelease identifiers: dot-separated, each identifier compared
 *      - Numeric identifiers are compared numerically (rc.9 < rc.10)
 *      - Alphanumeric identifiers are compared lexicographically
 *      - Numeric < alphanumeric for the same position (semver §11.4.1.3)
 *      - Shorter prerelease wins when all shared identifiers are equal (semver §11.4.4)
 *   4. Build metadata: compared dot-by-dot, numeric-aware (+1 < +2, +build-1 < +build-2)
 *      This follows pub's convention of treating build as a tie-breaker.
 *
 * Parsing order:
 *   1. Split on first '+' → build metadata
 *   2. Split pre-build portion on first '-' → prerelease
 *   3. Parse release as numeric triple
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return a.localeCompare(b);

  // Compare release triple
  for (let i = 0; i < 3; i++) {
    const diff = (pa.release[i] ?? 0) - (pb.release[i] ?? 0);
    if (diff !== 0) return diff;
  }

  // Prerelease < release
  if (pa.prerelease !== null && pb.prerelease === null) return -1;
  if (pa.prerelease === null && pb.prerelease !== null) return 1;

  // Both have prerelease — compare identifiers dot-by-dot
  if (pa.prerelease !== null && pb.prerelease !== null) {
    const cmp = compareIdentifierList(pa.prerelease, pb.prerelease);
    if (cmp !== 0) return cmp;
  }

  // Same release + same prerelease → compare build metadata (pub tie-breaker)
  if (pa.build !== null || pb.build !== null) {
    if (pa.build === null) return -1;
    if (pb.build === null) return 1;
    const cmp = compareIdentifierList(pa.build, pb.build);
    if (cmp !== 0) return cmp;
  }

  return 0;
}

/**
 * Compare two dot-separated identifier lists per semver §11.4.
 * Each identifier is compared numerically if both sides are numeric,
 * otherwise lexicographically. Numeric < alphanumeric for same position.
 */
function compareIdentifierList(a: string, b: string): number {
  const partsA = a.split('.');
  const partsB = b.split('.');
  const len = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < len; i++) {
    const ai = partsA[i];
    const bi = partsB[i];
    // Shorter list is lower precedence (semver §11.4.4)
    if (ai === undefined) return -1;
    if (bi === undefined) return 1;
    const aNum = /^\d+$/.test(ai) ? parseInt(ai, 10) : NaN;
    const bNum = /^\d+$/.test(bi) ? parseInt(bi, 10) : NaN;
    if (!Number.isNaN(aNum) && !Number.isNaN(bNum)) {
      if (aNum !== bNum) return aNum - bNum;
    } else if (!Number.isNaN(aNum)) {
      return -1; // numeric < alphanumeric
    } else if (!Number.isNaN(bNum)) {
      return 1;  // alphanumeric > numeric
    } else {
      const cmp = ai.localeCompare(bi);
      if (cmp !== 0) return cmp;
    }
  }
  return 0;
}

interface ParsedSemver {
  release: number[];
  prerelease: string | null;
  build: string | null;
}

/**
 * Parse a pub.dev version string into structured components.
 *
 * Parsing order (prevents '-' inside build metadata from being mistaken for prerelease):
 *   1. Split on first '+' → build metadata  (e.g. "0.2.7+0" → build="0")
 *   2. Split pre-build portion on first '-' → prerelease
 *      (e.g. "1.0.0-beta+build-1" → prerelease="beta", build="build-1")
 */
function parseSemver(version: string): ParsedSemver | null {
  // Step 1: isolate build metadata
  const plusIdx = version.indexOf('+');
  const build = plusIdx >= 0 ? version.slice(plusIdx + 1) : null;
  const versionWithoutBuild = plusIdx >= 0 ? version.slice(0, plusIdx) : version;

  // Step 2: isolate prerelease
  const dashIdx = versionWithoutBuild.indexOf('-');
  const prerelease = dashIdx >= 0 ? versionWithoutBuild.slice(dashIdx + 1) : null;
  const releaseStr = dashIdx >= 0 ? versionWithoutBuild.slice(0, dashIdx) : versionWithoutBuild;

  // Step 3: parse release as numeric triple
  const parts = releaseStr.split('.').map(Number);
  if (parts.length < 2 || parts.some(p => !Number.isInteger(p) || p < 0)) {
    return null;
  }
  if (parts.length === 2) parts.push(0);

  return {
    release: [parts[0]!, parts[1]!, parts[2]!],
    prerelease: prerelease ?? null,
    build: build ?? null,
  };
}
