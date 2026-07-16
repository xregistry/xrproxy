import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import {
  ConfigurationError,
  createRegistryApp,
  listenWithGracefulShutdown,
  parseConfig,
  type ParsedConfig,
  parseProxyConfig
} from '../src';

const typingSchema = {
  REQUIRED: { type: 'string', required: true },
  DEFAULTED: { type: 'integer', default: 4 },
  OPTIONAL: { type: 'boolean' }
} as const;

const typedConfig: ParsedConfig<typeof typingSchema> = parseConfig(typingSchema, {
  REQUIRED: 'present'
});
const requiredValue: string = typedConfig.REQUIRED;
const defaultedValue: number = typedConfig.DEFAULTED;
const optionalValue: boolean | undefined = typedConfig.OPTIONAL;
// @ts-expect-error Optional configuration is not guaranteed to be present.
const invalidRequiredValue: boolean = typedConfig.OPTIONAL;
void [requiredValue, defaultedValue, optionalValue, invalidRequiredValue];

test('proxy configuration applies defaults and reports all validation failures', () => {
  const config = parseProxyConfig({ UPSTREAM_URL: 'https://registry.example.test' });
  assert.equal(config.PORT, 3000);
  assert.equal(config.UPSTREAM_TIMEOUT_MS, 10_000);
  assert.equal(config.UPSTREAM_OPERATION_TIMEOUT_MS, 30_000);
  assert.equal(config.UPSTREAM_URL, 'https://registry.example.test/');
  assert.deepEqual(typedConfig, { REQUIRED: 'present', DEFAULTED: 4 });

  assert.throws(
    () => parseProxyConfig({
      UPSTREAM_URL: 'ftp://invalid.example.test',
      PORT: '70000',
      UPSTREAM_MAX_ATTEMPTS: 'zero'
    }),
    (error: unknown) =>
      error instanceof ConfigurationError &&
      error.problems.length === 3
  );
});

test('server bootstrap exposes standard endpoints and closes gracefully', async () => {
  const app = createRegistryApp({
    model: { groups: {} },
    capabilities: async () => ({ filters: true }),
    readiness: () => false
  });
  const running = await listenWithGracefulShutdown(app, {
    host: '127.0.0.1',
    port: 0,
    signals: []
  });
  const address = running.server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  assert.deepEqual(await (await fetch(`${url}/health`)).json(), { status: 'ok' });
  const ready = await fetch(`${url}/ready`);
  assert.equal(ready.status, 503);
  assert.deepEqual(await (await fetch(`${url}/model`)).json(), { groups: {} });
  assert.deepEqual(await (await fetch(`${url}/capabilities`)).json(), { filters: true });

  const closed = once(running.server, 'close');
  await running.close();
  await closed;
});

test('forced shutdown awaits cleanup and removes registered signal handlers', async () => {
  let requestStartedResolve: (() => void) | undefined;
  const requestStarted = new Promise<void>(resolve => {
    requestStartedResolve = resolve;
  });
  let shutdownComplete = false;
  const signal: NodeJS.Signals = 'SIGUSR2';
  const listenersBefore = process.listenerCount(signal);
  const app = createRegistryApp({
    model: {},
    capabilities: {},
    configure(expressApp) {
      expressApp.get('/hold', (_request, _response) => {
        requestStartedResolve?.();
      });
    }
  });
  const running = await listenWithGracefulShutdown(app, {
    host: '127.0.0.1',
    port: 0,
    signals: [signal],
    shutdownTimeoutMs: 10,
    onShutdown: async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
      shutdownComplete = true;
    }
  });
  const address = running.server.address();
  assert.ok(address && typeof address !== 'string');
  const pendingRequest = fetch(`http://127.0.0.1:${address.port}/hold`).catch(() => undefined);
  await requestStarted;

  await assert.rejects(running.close(), /forced closed/);
  await pendingRequest;
  assert.equal(shutdownComplete, true);
  assert.equal(process.listenerCount(signal), listenersBefore);
  assert.equal(running.server.listening, false);
});
