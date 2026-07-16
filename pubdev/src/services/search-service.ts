/**
 * Package catalogue service — uses /api/package-names for authoritative enumeration
 */

import { FALLBACK_PACKAGES } from '../config/constants';
import { PubDevService } from './pubdev-service';

export class SearchService {
  private names: string[] = [];
  private nameSet: Set<string> = new Set();
  private loaded = false;
  private loading: Promise<void> | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private readonly refreshIntervalMs: number;

  constructor(
    private readonly pubdev: PubDevService,
    refreshIntervalMs = 12 * 60 * 60 * 1000, // 12 h
  ) {
    this.refreshIntervalMs = refreshIntervalMs;
  }

  /** Load package names on first call; subsequent calls are no-ops. */
  async initialize(): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = this.refresh();
    await this.loading;
    this.scheduleRefresh();
  }

  private async refresh(): Promise<void> {
    try {
      const names = await this.pubdev.fetchPackageNames();
      if (names.length > 0) {
        this.names = names;
        this.nameSet = new Set(names);
      } else {
        this.applyFallback();
      }
    } catch {
      if (!this.loaded) this.applyFallback();
    } finally {
      this.loaded = true;
    }
  }

  private applyFallback(): void {
    if (this.names.length === 0) {
      this.names = [...FALLBACK_PACKAGES].sort();
      this.nameSet = new Set(this.names);
    }
  }

  private scheduleRefresh(): void {
    this.refreshTimer = setInterval(() => { void this.refresh(); }, this.refreshIntervalMs);
    this.refreshTimer.unref?.();
  }

  stop(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  // ── Accessors ─────────────────────────────────────────────────────────────

  /** All known package names, sorted. Authoritative when loaded from /api/package-names. */
  getAll(): string[] { return this.names; }

  /** True only after a successful /api/package-names fetch (not fallback). */
  isAuthoritative(): boolean { return this.loaded && this.names.length > FALLBACK_PACKAGES.length; }

  isReady(): boolean { return this.loaded; }

  isKnown(name: string): boolean { return this.nameSet.has(name); }

  /** Register a package after a successful live lookup. */
  register(name: string): void {
    if (!this.nameSet.has(name)) {
      this.names.push(name);
      this.names.sort();
      this.nameSet.add(name);
    }
  }

  async exists(name: string): Promise<boolean> {
    if (this.nameSet.has(name)) return true;
    const ok = await this.pubdev.packageExists(name);
    if (ok) this.register(name);
    return ok;
  }
}
