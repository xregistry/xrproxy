/**
 * Go Module Service
 *
 * Provides three capabilities:
 *  1. Exact lookup via the GOPROXY protocol (proxy.golang.org).
 *  2. Append-only discovery via the Go module index (index.golang.org).
 *  3. Optional checksum lookups via the Go checksum database (sum.golang.org).
 *
 * Upstream access uses the resilient HttpUpstreamClient from
 * @xregistry/registry-core (retries, timeouts, cancellation, 404/429 mapping).
 * Base URLs are injected through the constructor so tests can point the client
 * at local fixture servers without touching process.env.
 */

import { HttpUpstreamClient, type HttpClientOptions } from '@xregistry/registry-core';
import { GoChecksumRecord, GoIndexEntry, GoVersionInfo, ParsedGoMod } from '../types/go';
import { parseGoMod } from '../utils/go-mod-parser';
import { escapePath, escapeVersion } from '../utils/path-escaping';
import { CheckpointService } from './checkpoint-service';

export interface GoModuleServiceOptions extends HttpClientOptions {
  proxyBaseUrl: string;
  indexBaseUrl: string;
  sumDbBaseUrl?: string;
  indexPageLimit?: number;
  indexMaxPages?: number;
  indexRefreshMs?: number;
}

export class GoModuleService {
  private readonly proxyClient: HttpUpstreamClient;
  private readonly indexClient: HttpUpstreamClient;
  private readonly sumDbClient: HttpUpstreamClient;
  private readonly opts: Required<Pick<GoModuleServiceOptions, 'proxyBaseUrl'|'indexBaseUrl'|'sumDbBaseUrl'|'indexPageLimit'|'indexMaxPages'|'indexRefreshMs'>>;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private refreshing = false;
  private abortController: AbortController = new AbortController();
  private readonly modFileCache = new Map<string, Promise<string | null>>();
  private readonly parsedModCache = new Map<string, Promise<ParsedGoMod | null>>();
  private readonly checksumCache = new Map<string, Promise<GoChecksumRecord>>();

  constructor(
    private readonly checkpoint: CheckpointService,
    options: GoModuleServiceOptions
  ) {
    const {
      proxyBaseUrl,
      indexBaseUrl,
      sumDbBaseUrl = 'https://sum.golang.org',
      indexPageLimit = 2000,
      indexMaxPages = 50,
      indexRefreshMs = 6 * 60 * 60 * 1000,
      ...httpOpts
    } = options;
    this.opts = { proxyBaseUrl, indexBaseUrl, sumDbBaseUrl, indexPageLimit, indexMaxPages, indexRefreshMs };
    this.proxyClient = new HttpUpstreamClient({ timeoutMs: 30_000, operationTimeoutMs: 60_000, ...httpOpts });
    this.indexClient = new HttpUpstreamClient({ timeoutMs: 60_000, operationTimeoutMs: 120_000, ...httpOpts });
    this.sumDbClient = new HttpUpstreamClient({ timeoutMs: 30_000, operationTimeoutMs: 60_000, ...httpOpts });
  }

  proxyUrl(modulePath: string, version: string, suffix: 'info' | 'mod' | 'zip'): string {
    return `${this.opts.proxyBaseUrl}/${escapePath(modulePath)}/@v/${escapeVersion(version)}.${suffix}`;
  }

  async getVersionInfo(modulePath: string, version: string, signal?: AbortSignal): Promise<GoVersionInfo | null> {
    const url = `${this.opts.proxyBaseUrl}/${escapePath(modulePath)}/@v/${escapeVersion(version)}.info`;
    try {
      const r = await this.proxyClient.request<GoVersionInfo>({
        url, parse: (res) => res.json() as Promise<GoVersionInfo>, signal,
      });
      return 'notModified' in r ? null : r.value;
    } catch (e: any) {
      if (e?.code === 'not_found') return null;
      throw e;
    }
  }

  async getLatest(modulePath: string, signal?: AbortSignal): Promise<GoVersionInfo | null> {
    const url = `${this.opts.proxyBaseUrl}/${escapePath(modulePath)}/@latest`;
    try {
      const r = await this.proxyClient.request<GoVersionInfo>({
        url, parse: (res) => res.json() as Promise<GoVersionInfo>, signal,
      });
      return 'notModified' in r ? null : r.value;
    } catch (e: any) {
      if (e?.code === 'not_found') return null;
      throw e;
    }
  }

  async listVersions(modulePath: string, signal?: AbortSignal): Promise<string[]> {
    const url = `${this.opts.proxyBaseUrl}/${escapePath(modulePath)}/@v/list`;
    try {
      const r = await this.proxyClient.request<string>({
        url, parse: (res) => res.text(), signal,
      });
      if ('notModified' in r) return [];
      return r.value.split('\n').map((value) => value.trim()).filter(Boolean);
    } catch (e: any) {
      if (e?.code === 'not_found') return [];
      throw e;
    }
  }

  async getModFile(modulePath: string, version: string, signal?: AbortSignal): Promise<string | null> {
    const cacheKey = `${modulePath}@${version}`;
    const existing = this.modFileCache.get(cacheKey);
    if (existing) return existing;

    const work = (async () => {
      const url = `${this.opts.proxyBaseUrl}/${escapePath(modulePath)}/@v/${escapeVersion(version)}.mod`;
      try {
        const r = await this.proxyClient.request<string>({
          url, parse: (res) => res.text(), signal,
        });
        return 'notModified' in r ? null : r.value;
      } catch (e: any) {
        if (e?.code === 'not_found') return null;
        throw e;
      }
    })();

    this.modFileCache.set(cacheKey, work);
    void work.catch(() => this.modFileCache.delete(cacheKey));
    return work;
  }

  async getParsedGoMod(modulePath: string, version: string, signal?: AbortSignal): Promise<ParsedGoMod | null> {
    const cacheKey = `${modulePath}@${version}`;
    const existing = this.parsedModCache.get(cacheKey);
    if (existing) return existing;

    const work = (async () => {
      const text = await this.getModFile(modulePath, version, signal);
      return text ? parseGoMod(text) : null;
    })();

    this.parsedModCache.set(cacheKey, work);
    void work.catch(() => this.parsedModCache.delete(cacheKey));
    return work;
  }

  async getChecksumRecord(modulePath: string, version: string, signal?: AbortSignal): Promise<GoChecksumRecord> {
    const cacheKey = `${modulePath}@${version}`;
    const existing = this.checksumCache.get(cacheKey);
    if (existing) return existing;

    const work = (async () => {
      const url = `${this.opts.sumDbBaseUrl}/lookup/${escapePath(modulePath)}@${escapeVersion(version)}`;
      try {
        const r = await this.sumDbClient.request<string>({
          url, parse: (res) => res.text(), signal,
        });
        if ('notModified' in r) return {};
        return this.parseChecksumLookup(modulePath, version, r.value);
      } catch (e: any) {
        if (e?.code === 'not_found') return {};
        throw e;
      }
    })();

    this.checksumCache.set(cacheKey, work);
    void work.catch(() => this.checksumCache.delete(cacheKey));
    return work;
  }

  private parseChecksumLookup(modulePath: string, version: string, text: string): GoChecksumRecord {
    const result: GoChecksumRecord = {};
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      const fields = line.split(/\s+/);
      if (fields.length < 3 || fields[0] !== modulePath) continue;

      if (fields[1] === version) {
        result.zipHash = fields[2];
      } else if (fields[1] === `${version}/go.mod`) {
        result.gomodHash = fields[2];
      }
    }
    return result;
  }

  async fetchIndexPage(since: string, signal?: AbortSignal): Promise<{ entries: GoIndexEntry[]; nextSince: string }> {
    const url = `${this.opts.indexBaseUrl}/index?since=${encodeURIComponent(since)}&limit=${this.opts.indexPageLimit}`;
    const r = await this.indexClient.request<string>({ url, parse: (res) => res.text(), signal });
    const text = 'notModified' in r ? '' : r.value;
    const entries = text.split('\n').map((line) => line.trim()).filter(Boolean)
      .map((line) => { try { return JSON.parse(line) as GoIndexEntry; } catch { return null; } })
      .filter((entry): entry is GoIndexEntry => entry !== null);
    const lastTs = entries.length > 0 ? entries[entries.length - 1].Timestamp : since;
    return { entries, nextSince: lastTs };
  }

  async refreshIndex(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    const signal = this.abortController.signal;
    try {
      let since = this.checkpoint.getCheckpoint().since;
      let totalFetched = 0;
      for (let page = 0; page < this.opts.indexMaxPages; page++) {
        if (signal.aborted) break;
        const { entries, nextSince } = await this.fetchIndexPage(since, signal);
        if (entries.length === 0) break;

        this.checkpoint.mergeEntries(entries.map((entry) => ({ path: entry.Path, version: entry.Version, timestamp: entry.Timestamp })));
        totalFetched += entries.length;
        await new Promise<void>((resolve) => setImmediate(resolve));

        if (entries.length < this.opts.indexPageLimit) {
          this.checkpoint.updateCheckpoint(nextSince);
          break;
        }
        since = nextSince;
        this.checkpoint.updateCheckpoint(since);
      }
      if (totalFetched > 0) this.checkpoint.save();
    } catch (e: any) {
      if (e?.code !== 'cancelled') console.error('[GoModuleService] Index refresh error:', e?.message ?? e);
    } finally {
      this.refreshing = false;
    }
  }

  startIndexRefresh(): void {
    if (this.refreshTimer) return;
    void this.refreshIndex();
    this.refreshTimer = setInterval(() => void this.refreshIndex(), this.opts.indexRefreshMs);
  }

  stopIndexRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.abortController.abort();
  }
}
