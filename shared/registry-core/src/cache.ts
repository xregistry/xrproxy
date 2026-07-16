import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { isUpstreamError } from './errors';

export type CacheEntryKind = 'positive' | 'negative';

export interface CacheEntry<T> {
  readonly kind: CacheEntryKind;
  readonly value?: T;
  readonly storedAt: number;
  readonly expiresAt: number;
  readonly staleUntil: number;
  readonly etag?: string;
  readonly lastModified?: string;
}

export interface CacheStore {
  get<T>(key: string): Promise<CacheEntry<T> | undefined>;
  set<T>(key: string, entry: CacheEntry<T>): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface CachePolicy {
  readonly ttlMs: number;
  readonly negativeTtlMs?: number;
  readonly staleIfErrorMs?: number;
}

export interface CacheLoadContext {
  readonly etag?: string;
  readonly lastModified?: string;
}

export type CacheLoadResult<T> =
  | { readonly kind: 'value'; readonly value: T; readonly etag?: string; readonly lastModified?: string }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'not-modified'; readonly etag?: string; readonly lastModified?: string };

export interface CacheResult<T> {
  readonly kind: 'value' | 'not-found';
  readonly source: 'cache' | 'upstream' | 'stale';
  readonly value?: T;
}

function assertSafeKey(key: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(key)) {
    throw new Error('Cache keys must be non-empty Base64URL strings');
  }
}

function immutableClone<T>(value: T): T {
  const cloned = structuredClone(value);
  if (cloned && typeof cloned === 'object') {
    return deepFreeze(cloned);
  }
  return cloned;
}

function deepFreeze<T>(value: T): T {
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    if (child && typeof child === 'object' && !Object.isFrozen(child)) {
      deepFreeze(child);
    }
  }
  return value;
}

function cloneEntry<T>(entry: CacheEntry<T>): CacheEntry<T> {
  return immutableClone(entry);
}

export function createCacheKey(...parts: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('base64url');
}

export class MemoryCacheStore implements CacheStore {
  private readonly entries = new Map<string, CacheEntry<unknown>>();

  async get<T>(key: string): Promise<CacheEntry<T> | undefined> {
    assertSafeKey(key);
    const entry = this.entries.get(key);
    return entry === undefined ? undefined : cloneEntry(entry as CacheEntry<T>);
  }

  async set<T>(key: string, entry: CacheEntry<T>): Promise<void> {
    assertSafeKey(key);
    this.entries.set(key, cloneEntry(entry));
  }

  async delete(key: string): Promise<void> {
    assertSafeKey(key);
    this.entries.delete(key);
  }
}

export class FileSystemCacheStore implements CacheStore {
  private readonly operations = new Map<string, Promise<void>>();
  private readonly renameFile: typeof rename;

  constructor(
    private readonly directory: string,
    options: { readonly rename?: typeof rename } = {}
  ) {
    this.renameFile = options.rename ?? rename;
  }

  async get<T>(key: string): Promise<CacheEntry<T> | undefined> {
    assertSafeKey(key);
    return this.withKeyLock(key, async () => {
      try {
        const content = await readFile(this.pathFor(key), 'utf8');
        return cloneEntry(JSON.parse(content) as CacheEntry<T>);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return undefined;
        }
        throw error;
      }
    });
  }

  async set<T>(key: string, entry: CacheEntry<T>): Promise<void> {
    assertSafeKey(key);
    await this.withKeyLock(key, () => this.writeEntry(key, entry));
  }

  private async writeEntry<T>(key: string, entry: CacheEntry<T>): Promise<void> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(cloneEntry(entry)), {
        encoding: 'utf8',
        flag: 'wx'
      });
      await this.replaceFile(temporary, path);
    } finally {
      try {
        await unlink(temporary);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
    }
  }

  async delete(key: string): Promise<void> {
    assertSafeKey(key);
    await this.withKeyLock(key, async () => {
      try {
        await unlink(this.pathFor(key));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
    });
  }

  private pathFor(key: string): string {
    return join(this.directory, `${key}.json`);
  }

  private async replaceFile(temporary: string, path: string): Promise<void> {
    try {
      await this.renameFile(temporary, path);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' && code !== 'EPERM') {
        throw error;
      }
    }

    const backup = `${path}.${randomUUID()}.bak`;
    let hasBackup = false;
    let preserveBackup = false;
    try {
      try {
        await this.renameFile(path, backup);
        hasBackup = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
      try {
        await this.renameFile(temporary, path);
      } catch (replacementError) {
        if (hasBackup) {
          try {
            await this.renameFile(backup, path);
            hasBackup = false;
          } catch (restoreError) {
            preserveBackup = true;
            throw new AggregateError(
              [replacementError, restoreError],
              'Cache replacement failed and the prior entry could not be restored'
            );
          }
        }
        throw replacementError;
      }
    } finally {
      if (hasBackup && !preserveBackup) {
        try {
          await unlink(backup);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
          }
        }
      }
    }
  }

  private async withKeyLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(key) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.operations.set(key, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release?.();
      if (this.operations.get(key) === tail) {
        this.operations.delete(key);
      }
    }
  }
}

export class TtlCache {
  private readonly inFlight = new Map<string, Promise<CacheResult<unknown>>>();
  private readonly now: () => number;

  constructor(
    private readonly store: CacheStore,
    private readonly policy: CachePolicy,
    options: { readonly now?: () => number } = {}
  ) {
    this.now = options.now ?? Date.now;
    if (policy.ttlMs < 0 || (policy.negativeTtlMs ?? 0) < 0 || (policy.staleIfErrorMs ?? 0) < 0) {
      throw new Error('Cache TTL values cannot be negative');
    }
  }

  async get<T>(
    key: string,
    loader: (context: CacheLoadContext) => Promise<CacheLoadResult<T>>
  ): Promise<CacheResult<T>> {
    assertSafeKey(key);
    const cached = await this.store.get<T>(key);
    const now = this.now();
    if (cached && cached.expiresAt > now) {
      return this.toResult(cached, 'cache');
    }

    const existing = this.inFlight.get(key) as Promise<CacheResult<T>> | undefined;
    if (existing) {
      return existing;
    }
    const load = this.load(key, cached, loader).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, load as Promise<CacheResult<unknown>>);
    return load;
  }

  private async load<T>(
    key: string,
    cached: CacheEntry<T> | undefined,
    loader: (context: CacheLoadContext) => Promise<CacheLoadResult<T>>
  ): Promise<CacheResult<T>> {
    const context: CacheLoadContext = {
      ...(cached?.etag === undefined ? {} : { etag: cached.etag }),
      ...(cached?.lastModified === undefined ? {} : { lastModified: cached.lastModified })
    };
    try {
      const loaded = await loader(context);
      const now = this.now();
      if (loaded.kind === 'not-modified') {
        if (!cached) {
          throw new Error('Loader returned not-modified without an existing cache entry');
        }
        const refreshed: CacheEntry<T> = {
          ...cached,
          storedAt: now,
          expiresAt: now + (cached.kind === 'negative'
            ? (this.policy.negativeTtlMs ?? this.policy.ttlMs)
            : this.policy.ttlMs),
          staleUntil: now + this.policy.ttlMs + (this.policy.staleIfErrorMs ?? 0),
          ...((loaded.etag ?? cached.etag) === undefined
            ? {}
            : { etag: loaded.etag ?? cached.etag }),
          ...((loaded.lastModified ?? cached.lastModified) === undefined
            ? {}
            : { lastModified: loaded.lastModified ?? cached.lastModified })
        };
        await this.store.set(key, refreshed);
        return this.toResult(refreshed, 'cache');
      }
      if (loaded.kind === 'not-found') {
        const negative = this.createEntry<T>('negative', undefined, now);
        await this.store.set(key, negative);
        return { kind: 'not-found', source: 'upstream' };
      }
      const positive = this.createEntry('positive', loaded.value, now, loaded.etag, loaded.lastModified);
      await this.store.set(key, positive);
      return { kind: 'value', source: 'upstream', value: immutableClone(loaded.value) };
    } catch (error) {
      if (isUpstreamError(error) && error.code === 'not_found') {
        const now = this.now();
        await this.store.set(key, this.createEntry<T>('negative', undefined, now));
        return { kind: 'not-found', source: 'upstream' };
      }
      if (
        cached?.kind === 'positive' &&
        cached.staleUntil > this.now() &&
        isUpstreamError(error) &&
        error.code !== 'cancelled'
      ) {
        return this.toResult(cached, 'stale');
      }
      throw error;
    }
  }

  private createEntry<T>(
    kind: CacheEntryKind,
    value: T | undefined,
    now: number,
    etag?: string,
    lastModified?: string
  ): CacheEntry<T> {
    const ttl = kind === 'negative' ? (this.policy.negativeTtlMs ?? this.policy.ttlMs) : this.policy.ttlMs;
    return {
      kind,
      ...(value === undefined ? {} : { value: immutableClone(value) }),
      storedAt: now,
      expiresAt: now + ttl,
      staleUntil: now + ttl + (kind === 'positive' ? (this.policy.staleIfErrorMs ?? 0) : 0),
      ...(etag === undefined ? {} : { etag }),
      ...(lastModified === undefined ? {} : { lastModified })
    };
  }

  private toResult<T>(entry: CacheEntry<T>, source: 'cache' | 'stale'): CacheResult<T> {
    return entry.kind === 'negative'
      ? { kind: 'not-found', source }
      : { kind: 'value', source, value: immutableClone(entry.value as T) };
  }
}
