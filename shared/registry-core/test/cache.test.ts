import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, rename as fsRename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import {
  createCacheKey,
  FileSystemCacheStore,
  MemoryCacheStore,
  TtlCache,
  UpstreamError
} from '../src';

test('positive cache entries expire according to TTL and refresh on 304', async () => {
  let now = 1_000;
  let loads = 0;
  const store = new MemoryCacheStore();
  const cache = new TtlCache(store, { ttlMs: 100, staleIfErrorMs: 500 }, { now: () => now });
  const key = createCacheKey('package', '@scope/name');

  const first = await cache.get(key, async () => {
    loads += 1;
    return { kind: 'value', value: { version: 1 }, etag: '"v1"' };
  });
  assert.deepEqual(first, { kind: 'value', source: 'upstream', value: { version: 1 } });

  now += 50;
  assert.equal((await cache.get(key, async () => {
    throw new Error('should not load');
  })).source, 'cache');

  now += 51;
  const refreshed = await cache.get(key, async conditional => {
    loads += 1;
    assert.equal(conditional.etag, '"v1"');
    return { kind: 'not-modified' };
  });
  assert.equal(refreshed.source, 'cache');

  now += 99;
  assert.equal((await cache.get(key, async () => {
    throw new Error('should not load');
  })).source, 'cache');
  assert.equal(loads, 2);
});

test('stale-if-error serves only positive entries inside the stale window', async () => {
  let now = 0;
  const cache = new TtlCache(
    new MemoryCacheStore(),
    { ttlMs: 10, staleIfErrorMs: 20 },
    { now: () => now }
  );
  const key = createCacheKey('stale');
  await cache.get(key, async () => ({ kind: 'value', value: { ok: true } }));

  now = 11;
  const stale = await cache.get(key, async () => {
    throw new UpstreamError({ code: 'server_error', message: 'down', retryable: true });
  });
  assert.deepEqual(stale, { kind: 'value', source: 'stale', value: { ok: true } });

  now = 31;
  await assert.rejects(
    cache.get(key, async () => {
      throw new UpstreamError({ code: 'server_error', message: 'down', retryable: true });
    }),
    (error: unknown) => error instanceof UpstreamError && error.code === 'server_error'
  );
});

test('negative responses are cached with an independent TTL', async () => {
  let now = 0;
  let loads = 0;
  const cache = new TtlCache(
    new MemoryCacheStore(),
    { ttlMs: 1_000, negativeTtlMs: 20 },
    { now: () => now }
  );
  const key = createCacheKey('missing');
  const loader = async () => {
    loads += 1;
    throw new UpstreamError({ code: 'not_found', message: 'missing', status: 404 });
  };

  assert.deepEqual(await cache.get(key, loader), { kind: 'not-found', source: 'upstream' });
  now = 19;
  assert.deepEqual(await cache.get(key, loader), { kind: 'not-found', source: 'cache' });
  assert.equal(loads, 1);
  now = 21;
  assert.deepEqual(await cache.get(key, loader), { kind: 'not-found', source: 'upstream' });
  assert.equal(loads, 2);
});

test('concurrent misses for the same key are coalesced into one load', async () => {
  const cache = new TtlCache(new MemoryCacheStore(), { ttlMs: 100 });
  const key = createCacheKey('coalesce');
  let resolveLoad: ((value: { kind: 'value'; value: number }) => void) | undefined;
  let loads = 0;
  const loader = () => {
    loads += 1;
    return new Promise<{ kind: 'value'; value: number }>(resolve => {
      resolveLoad = resolve;
    });
  };

  const results = [cache.get(key, loader), cache.get(key, loader), cache.get(key, loader)];
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(loads, 1);
  resolveLoad?.({ kind: 'value', value: 42 });
  assert.deepEqual(await Promise.all(results), [
    { kind: 'value', source: 'upstream', value: 42 },
    { kind: 'value', source: 'upstream', value: 42 },
    { kind: 'value', source: 'upstream', value: 42 }
  ]);
});

test('cache keys are Base64URL-safe and filesystem entries are immutable copies', async () => {
  const key = createCacheKey('../unsafe', '東京', 'a/b+c=');
  assert.match(key, /^[A-Za-z0-9_-]+$/);
  assert.doesNotMatch(key, /[./+=\\]/);

  const directory = join(process.cwd(), '.test-cache');
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  try {
    const store = new FileSystemCacheStore(directory);
    const original = { nested: { value: 1 } };
    await store.set(key, {
      kind: 'positive',
      value: original,
      storedAt: 0,
      expiresAt: 10,
      staleUntil: 20
    });
    original.nested.value = 2;
    const cached = await store.get<typeof original>(key);
    assert.equal(cached?.value?.nested.value, 1);
    assert.equal(Object.isFrozen(cached), true);
    assert.deepEqual(await readdir(directory), [`${key}.json`]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('filesystem cache concurrent writes are atomic and leave no temporary files', async () => {
  const directory = join(process.cwd(), '.test-cache');
  await rm(directory, { recursive: true, force: true });
  const store = new FileSystemCacheStore(directory);
  const key = createCacheKey('concurrent-write');
  try {
    await Promise.all(Array.from({ length: 25 }, async (_, value) => {
      await store.set(key, {
        kind: 'positive',
        value,
        storedAt: value,
        expiresAt: 100,
        staleUntil: 100
      });
    }));
    const cached = await store.get<number>(key);
    assert.ok(cached?.value !== undefined && cached.value >= 0 && cached.value < 25);
    assert.deepEqual(await readdir(directory), [`${key}.json`]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('filesystem replacement serializes readers and restores the old entry on failure', async () => {
  const directory = join(process.cwd(), '.test-cache');
  await rm(directory, { recursive: true, force: true });
  const key = createCacheKey('replacement');
  let mode: 'normal' | 'pause' | 'fail' = 'normal';
  let replacementCall = 0;
  let movedOldResolve: (() => void) | undefined;
  let continueResolve: (() => void) | undefined;
  const movedOld = new Promise<void>(resolve => {
    movedOldResolve = resolve;
  });
  const continueReplacement = new Promise<void>(resolve => {
    continueResolve = resolve;
  });
  const store = new FileSystemCacheStore(directory, {
    rename: async (oldPath, newPath) => {
      if (mode === 'normal') {
        return fsRename(oldPath, newPath);
      }
      replacementCall += 1;
      if (replacementCall === 1) {
        const error = new Error('replace unsupported') as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      }
      if (replacementCall === 2) {
        await fsRename(oldPath, newPath);
        if (mode === 'pause') {
          movedOldResolve?.();
          await continueReplacement;
        }
        return;
      }
      if (mode === 'fail' && replacementCall === 3) {
        const error = new Error('replacement failed') as NodeJS.ErrnoException;
        error.code = 'EIO';
        throw error;
      }
      return fsRename(oldPath, newPath);
    }
  });

  const entry = (value: string) => ({
    kind: 'positive' as const,
    value,
    storedAt: 0,
    expiresAt: 100,
    staleUntil: 100
  });
  try {
    await store.set(key, entry('old'));

    mode = 'pause';
    replacementCall = 0;
    const replacing = store.set(key, entry('new'));
    await movedOld;
    let readSettled = false;
    const concurrentRead = store.get<string>(key).finally(() => {
      readSettled = true;
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(readSettled, false);
    continueResolve?.();
    await replacing;
    assert.equal((await concurrentRead)?.value, 'new');

    mode = 'fail';
    replacementCall = 0;
    await assert.rejects(store.set(key, entry('lost')), /replacement failed/);
    assert.equal((await store.get<string>(key))?.value, 'new');
    assert.deepEqual(await readdir(directory), [`${key}.json`]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('filesystem replacement preserves its backup when replacement and restoration fail', async () => {
  const directory = join(process.cwd(), '.test-cache');
  await rm(directory, { recursive: true, force: true });
  const key = createCacheKey('unrecoverable-replacement');
  let injectFailures = false;
  let renameCall = 0;
  const store = new FileSystemCacheStore(directory, {
    rename: async (oldPath, newPath) => {
      if (!injectFailures) {
        return fsRename(oldPath, newPath);
      }
      renameCall += 1;
      if (renameCall === 1) {
        const error = new Error('replace unsupported') as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      }
      if (renameCall === 2) {
        return fsRename(oldPath, newPath);
      }
      const error = new Error(renameCall === 3 ? 'replacement failed' : 'restoration failed') as NodeJS.ErrnoException;
      error.code = 'EIO';
      throw error;
    }
  });
  const entry = (value: string) => ({
    kind: 'positive' as const,
    value,
    storedAt: 0,
    expiresAt: 100,
    staleUntil: 100
  });
  try {
    await store.set(key, entry('recoverable-old-value'));
    injectFailures = true;
    await assert.rejects(
      store.set(key, entry('new-value')),
      (error: unknown) =>
        error instanceof AggregateError &&
        error.message.includes('prior entry could not be restored')
    );

    const files = await readdir(directory);
    const backup = files.find(file => file.endsWith('.bak'));
    assert.ok(backup);
    assert.equal(files.some(file => file.endsWith('.tmp')), false);
    const preserved = JSON.parse(await readFile(join(directory, backup), 'utf8')) as {
      value: string;
    };
    assert.equal(preserved.value, 'recoverable-old-value');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
