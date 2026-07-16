/**
 * Go Module Service
 *
 * Provides two capabilities:
 *  1. Exact lookup via the GOPROXY protocol (proxy.golang.org).
 *  2. Append-only discovery via the Go module index (index.golang.org).
 *
 * Upstream access uses the resilient HttpUpstreamClient from
 * @xregistry/registry-core (retries, timeouts, cancellation, 404/429 mapping).
 * Base URLs are injected through the constructor so tests can point the client
 * at a local fixture server without touching process.env.
 */

import { HttpUpstreamClient, type HttpClientOptions } from '@xregistry/registry-core';
import { GoVersionInfo, GoIndexEntry } from '../types/go';
import { escapePath, escapeVersion } from '../utils/path-escaping';
import { CheckpointService } from './checkpoint-service';

export interface GoModuleServiceOptions extends HttpClientOptions {
  proxyBaseUrl: string;    // e.g. 'https://proxy.golang.org'
  indexBaseUrl: string;    // e.g. 'https://index.golang.org'
  indexPageLimit?: number;
  indexMaxPages?: number;
  indexRefreshMs?: number;
}

export class GoModuleService {
  private readonly proxyClient: HttpUpstreamClient;
  private readonly indexClient: HttpUpstreamClient;
  private readonly opts: Required<Pick<GoModuleServiceOptions, 'proxyBaseUrl'|'indexBaseUrl'|'indexPageLimit'|'indexMaxPages'|'indexRefreshMs'>>;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private refreshing = false;
  private abortController: AbortController = new AbortController();

  constructor(
    private readonly checkpoint: CheckpointService,
    options: GoModuleServiceOptions
  ) {
    const { proxyBaseUrl, indexBaseUrl, indexPageLimit = 2000, indexMaxPages = 50, indexRefreshMs = 6 * 60 * 60 * 1000, ...httpOpts } = options;
    this.opts = { proxyBaseUrl, indexBaseUrl, indexPageLimit, indexMaxPages, indexRefreshMs };
    this.proxyClient = new HttpUpstreamClient({ timeoutMs: 30_000, operationTimeoutMs: 60_000, ...httpOpts });
    this.indexClient = new HttpUpstreamClient({ timeoutMs: 60_000, operationTimeoutMs: 120_000, ...httpOpts });
  }

  // -------------------------------------------------------------------------
  // GOPROXY exact-lookup endpoints
  // -------------------------------------------------------------------------

  /**
   * Build a GOPROXY URL for the given module/version/suffix.
   * Suitable for embedding as a link in xRegistry version records.
   */
  proxyUrl(modulePath: string, version: string, suffix: 'info' | 'mod' | 'zip'): string {
    return `${this.opts.proxyBaseUrl}/${escapePath(modulePath)}/@v/${escapeVersion(version)}.${suffix}`;
  }

  async getVersionInfo(modulePath: string, version: string, signal?: AbortSignal): Promise<GoVersionInfo | null> {
    const url = `${this.opts.proxyBaseUrl}/${escapePath(modulePath)}/@v/${escapeVersion(version)}.info`;
    try {
      const r = await this.proxyClient.request<GoVersionInfo>({
        url, parse: res => res.json() as Promise<GoVersionInfo>, signal
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
        url, parse: res => res.json() as Promise<GoVersionInfo>, signal
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
        url, parse: res => res.text(), signal
      });
      if ('notModified' in r) return [];
      return r.value.split('\n').map(v => v.trim()).filter(Boolean);
    } catch (e: any) {
      if (e?.code === 'not_found') return [];
      throw e;
    }
  }

  // -------------------------------------------------------------------------
  // Go index discovery (append-only, resumable)
  // -------------------------------------------------------------------------

  async fetchIndexPage(since: string, signal?: AbortSignal): Promise<{ entries: GoIndexEntry[]; nextSince: string }> {
    const url = `${this.opts.indexBaseUrl}/index?since=${encodeURIComponent(since)}&limit=${this.opts.indexPageLimit}`;
    const r = await this.indexClient.request<string>({ url, parse: res => res.text(), signal });
    const text = 'notModified' in r ? '' : r.value;
    const entries = text.split('\n').map(l => l.trim()).filter(Boolean)
      .map(l => { try { return JSON.parse(l) as GoIndexEntry; } catch { return null; } })
      .filter((e): e is GoIndexEntry => e !== null);
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

        this.checkpoint.mergeEntries(entries.map(e => ({ path: e.Path, version: e.Version, timestamp: e.Timestamp })));
        totalFetched += entries.length;

        // ── Cursor fix: only advance the persisted checkpoint when the page is
        //    NOT full (i.e. we've reached the end of the index).  When the page
        //    is exactly full, keep the same `since` value; the dedup logic in
        //    mergeEntries() will skip any already-seen path+version pairs on the
        //    next call so we guarantee overlap and dedupe, not skip.
        if (entries.length < this.opts.indexPageLimit) {
          this.checkpoint.updateCheckpoint(nextSince);
          break;
        }
        // Full page: advance cursor to the last timestamp so we
        // guarantee overlap and dedupe, not skip.
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
    if (this.refreshTimer) { clearInterval(this.refreshTimer); this.refreshTimer = null; }
    this.abortController.abort();
  }
}
