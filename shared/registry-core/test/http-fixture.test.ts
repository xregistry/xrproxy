import assert from 'node:assert/strict';
import { Agent, get } from 'node:http';
import test from 'node:test';
import { HttpUpstreamClient, startFixtureServer, UpstreamError } from '../src';

test('HTTP client retries 429 and 5xx responses and honors rate-limit delay', async () => {
  const fixture = await startFixtureServer([{
    path: '/retry',
    responses: [
      { status: 429, headers: { 'retry-after': '0.01' } },
      { status: 503 },
      { body: { ok: true }, etag: '"done"' }
    ]
  }]);
  const delays: number[] = [];
  try {
    const client = new HttpUpstreamClient({
      maxAttempts: 3,
      baseDelayMs: 5,
      maxDelayMs: 100,
      jitterRatio: 0,
      sleep: async delay => {
        delays.push(delay);
      }
    });
    const result = await client.getJson<{ ok: boolean }>(`${fixture.url}/retry`);
    assert.deepEqual(result, {
      status: 200,
      value: { ok: true },
      etag: '"done"'
    });
    assert.deepEqual(delays, [10, 10]);
    assert.equal(fixture.requests.length, 3);
  } finally {
    await fixture.close();
  }
});

test('HTTP client normalizes 404 and sends conditional validators', async () => {
  const fixture = await startFixtureServer([
    { path: '/missing', responses: [{ status: 404 }] },
    { path: '/conditional', responses: [{ body: { value: 1 }, etag: '"v1"' }] }
  ]);
  try {
    const client = new HttpUpstreamClient({ maxAttempts: 1 });
    await assert.rejects(
      client.getJson(`${fixture.url}/missing`),
      (error: unknown) =>
        error instanceof UpstreamError &&
        error.code === 'not_found' &&
        error.status === 404 &&
        !error.retryable
    );
    const response = await client.getJson(`${fixture.url}/conditional`, {
      conditional: { etag: '"v1"' }
    });
    assert.deepEqual(response, {
      status: 304,
      notModified: true,
      etag: '"v1"'
    });
    assert.equal(fixture.requests[1]?.headers['if-none-match'], '"v1"');
  } finally {
    await fixture.close();
  }
});

test('fixture routes provide deterministic response sequences and request capture', async () => {
  const fixture = await startFixtureServer([{
    method: 'POST',
    path: '/sequence',
    responses: [
      { status: 201, body: { call: 1 } },
      { status: 202, body: { call: 2 } }
    ]
  }]);
  try {
    const options = { method: 'POST', body: 'payload', headers: { 'x-test': 'yes' } };
    const statuses = [];
    for (let index = 0; index < 3; index += 1) {
      const response = await fetch(`${fixture.url}/sequence`, options);
      statuses.push([response.status, await response.json()]);
    }
    assert.deepEqual(statuses, [
      [201, { call: 1 }],
      [202, { call: 2 }],
      [202, { call: 2 }]
    ]);
    assert.equal(fixture.requests.length, 3);
    assert.equal(fixture.requests[0]?.body, 'payload');
    assert.equal(fixture.requests[0]?.headers['x-test'], 'yes');
  } finally {
    await fixture.close();
  }
});

test('fixture shutdown closes persistent connections promptly', async () => {
  const fixture = await startFixtureServer([{
    path: '/keep-alive',
    responses: [{ body: { ok: true } }]
  }]);
  const agent = new Agent({ keepAlive: true });
  try {
    await new Promise<void>((resolve, reject) => {
      get(`${fixture.url}/keep-alive`, { agent }, response => {
        response.resume();
        response.once('end', resolve);
      }).once('error', reject);
    });
    const started = Date.now();
    await fixture.close();
    assert.ok(Date.now() - started < 1_000);
  } finally {
    agent.destroy();
  }
});

test('HTTP concurrency is bounded', async () => {
  let active = 0;
  let maximum = 0;
  const client = new HttpUpstreamClient({
    concurrency: 2,
    maxAttempts: 1,
    fetch: async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active -= 1;
      return new Response('{"ok":true}', {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
  });
  await Promise.all(Array.from({ length: 6 }, (_, index) =>
    client.getJson(`http://fixture.invalid/${index}`)
  ));
  assert.equal(maximum, 2);
});

test('HTTP timeout bounds the complete upstream operation', async () => {
  const fixture = await startFixtureServer([{
    path: '/slow',
    responses: [{ delayMs: 50, body: { tooLate: true } }]
  }]);
  try {
    const client = new HttpUpstreamClient({
      timeoutMs: 5,
      operationTimeoutMs: 100,
      maxAttempts: 1
    });
    await assert.rejects(
      client.getJson(`${fixture.url}/slow`),
      (error: unknown) =>
        error instanceof UpstreamError &&
        error.code === 'timeout' &&
        error.details?.scope === 'attempt'
    );
  } finally {
    await fixture.close();
  }
});

test('cancellation removes a semaphore waiter without leaking a permit', async () => {
  let releaseFirst: (() => void) | undefined;
  let calls = 0;
  const client = new HttpUpstreamClient({
    concurrency: 1,
    maxAttempts: 1,
    fetch: async () => {
      calls += 1;
      if (calls === 1) {
        await new Promise<void>(resolve => {
          releaseFirst = resolve;
        });
      }
      return new Response('{"ok":true}', { status: 200 });
    }
  });
  const first = client.getJson('http://fixture.invalid/first');
  while (calls === 0) {
    await new Promise(resolve => setImmediate(resolve));
  }
  const controller = new AbortController();
  const queued = client.getJson('http://fixture.invalid/queued', { signal: controller.signal });
  controller.abort();
  await assert.rejects(
    queued,
    (error: unknown) => error instanceof UpstreamError && error.code === 'cancelled'
  );
  releaseFirst?.();
  await first;
  await client.getJson('http://fixture.invalid/after');
  assert.equal(calls, 2);
});

test('cancellation interrupts retry backoff', async () => {
  let calls = 0;
  const client = new HttpUpstreamClient({
    maxAttempts: 3,
    baseDelayMs: 10_000,
    maxDelayMs: 10_000,
    jitterRatio: 0,
    fetch: async () => {
      calls += 1;
      return new Response('', { status: 503 });
    }
  });
  const controller = new AbortController();
  const request = client.getJson('http://fixture.invalid/backoff', { signal: controller.signal });
  while (calls === 0) {
    await new Promise(resolve => setImmediate(resolve));
  }
  controller.abort();
  await assert.rejects(
    request,
    (error: unknown) => error instanceof UpstreamError && error.code === 'cancelled'
  );
  assert.equal(calls, 1);
});

test('operation timeout includes semaphore queueing and retry backoff', async () => {
  let calls = 0;
  const started = Date.now();
  const client = new HttpUpstreamClient({
    timeoutMs: 1_000,
    operationTimeoutMs: 40,
    concurrency: 1,
    maxAttempts: 5,
    baseDelayMs: 1_000,
    maxDelayMs: 1_000,
    jitterRatio: 0,
    fetch: async () => {
      calls += 1;
      if (calls === 1) {
        await new Promise(resolve => setTimeout(resolve, 20));
        return new Response('{"ok":true}', { status: 200 });
      }
      return new Response('', { status: 503 });
    }
  });
  const first = client.getJson('http://fixture.invalid/occupy');
  while (calls === 0) {
    await new Promise(resolve => setImmediate(resolve));
  }
  const bounded = client.getJson('http://fixture.invalid/deadline');
  await assert.rejects(
    bounded,
    (error: unknown) =>
      error instanceof UpstreamError &&
      error.code === 'timeout' &&
      error.details?.scope === 'operation'
  );
  await first;
  assert.equal(calls, 2);
  assert.ok(Date.now() - started < 500);
});

test('fixture If-None-Match uses wildcard, lists, and weak comparison', async () => {
  const fixture = await startFixtureServer([
    {
      path: '/etag',
      responses: [{ body: { value: 1 }, etag: '"v1"' }]
    },
    {
      path: '/etag-with-comma',
      responses: [{ body: { value: 2 }, etag: '"release,2026"' }]
    }
  ]);
  try {
    for (const value of ['*', '"other", W/"v1"', 'W/"v1"']) {
      const response = await fetch(`${fixture.url}/etag`, {
        headers: { 'if-none-match': value }
      });
      assert.equal(response.status, 304, value);
    }
    const miss = await fetch(`${fixture.url}/etag`, {
      headers: { 'if-none-match': '"other"' }
    });
    assert.equal(miss.status, 200);
    const commaTag = await fetch(`${fixture.url}/etag-with-comma`, {
      headers: { 'if-none-match': '"other", W/"release,2026"' }
    });
    assert.equal(commaTag.status, 304);
  } finally {
    await fixture.close();
  }
});

test('a hanging response parser is aborted and releases its semaphore permit', async () => {
  let calls = 0;
  let bodyCancelled = false;
  const client = new HttpUpstreamClient({
    concurrency: 1,
    timeoutMs: 1_000,
    operationTimeoutMs: 25,
    maxAttempts: 1,
    fetch: async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(new ReadableStream({
          cancel() {
            bodyCancelled = true;
          }
        }), { status: 200 });
      }
      return new Response('{"ok":true}', { status: 200 });
    }
  });
  const hanging = client.request({
    url: 'http://fixture.invalid/hanging-parser',
    parse: async () => new Promise<never>(() => undefined)
  });
  await assert.rejects(
    hanging,
    (error: unknown) =>
      error instanceof UpstreamError &&
      error.code === 'timeout' &&
      error.details?.scope === 'operation'
  );
  const next = await client.getJson<{ ok: boolean }>('http://fixture.invalid/after-hang');
  assert.equal(next.status, 200);
  assert.equal(calls, 2);
  assert.equal(bodyCancelled, true);
});
