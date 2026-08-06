"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

// Keep the cache TTL small so the memoization test does not need to sleep
// for the production default (5s) and the timeout test resolves quickly.
process.env.HEALTH_PROBE_CACHE_TTL = "50";
process.env.SERVER_HEALTH_TIMEOUT = "30";

const { HealthService } = require("../dist/services/health-service");

const logger = { debug() {}, error() {}, info() {}, warn() {} };

function stateOf(url, overrides = {}) {
  return {
    server: { url },
    isActive: true,
    lastAttempt: Date.now(),
    model: { groups: { widgets: {} } },
    capabilities: {},
    error: undefined,
    ...overrides
  };
}

function modelServiceStub(groupTypeToBackend = { widgets: { url: "http://a.test" } }, collisions = []) {
  return {
    getGroupTypeToBackend: () => groupTypeToBackend,
    getGroupCollisions: () => collisions
  };
}

test("getHealth() never calls checkServerHealth and reflects cached state only", async () => {
  const states = new Map([
    ["http://a.test", stateOf("http://a.test")],
    ["http://b.test", stateOf("http://b.test", { isActive: false, error: "connect ECONNREFUSED" })]
  ]);

  let checkServerHealthCalls = 0;
  const downstreamServiceStub = {
    getServerStates: () => states,
    getActiveServers: () => Array.from(states.values()).filter(s => s.isActive),
    checkServerHealth: async () => {
      checkServerHealthCalls++;
      // If getHealth() ever awaits this, the test would hang past the
      // overall test timeout - fail fast instead by rejecting.
      throw new Error("getHealth() must not perform a live downstream probe");
    }
  };

  const modelService = modelServiceStub({ widgets: { url: "http://a.test" } });
  const healthService = new HealthService(downstreamServiceStub, modelService, logger);

  const start = Date.now();
  const health = await healthService.getHealth();
  const elapsed = Date.now() - start;

  assert.equal(checkServerHealthCalls, 0, "getHealth() must not fan out to downstreams");
  assert.ok(elapsed < 20, `getHealth() should be near-instant (cached), took ${elapsed}ms`);
  assert.equal(health.status, "healthy");
  assert.equal(health.activeServers, 1);
  assert.equal(health.totalServers, 2);

  const a = health.downstreams.find(d => d.url === "http://a.test");
  const b = health.downstreams.find(d => d.url === "http://b.test");
  assert.equal(a.healthy, true);
  assert.equal(a.active, true);
  assert.equal(b.healthy, false);
  assert.equal(b.active, false);
  assert.equal(b.error, "connect ECONNREFUSED");
});

test("getDetailedHealth() actively probes downstreams and memoizes within the TTL", async () => {
  const states = new Map([["http://a.test", stateOf("http://a.test")]]);
  let checkServerHealthCalls = 0;
  const downstreamServiceStub = {
    getServerStates: () => states,
    getActiveServers: () => Array.from(states.values()),
    checkServerHealth: async () => {
      checkServerHealthCalls++;
      return true;
    }
  };
  const modelService = modelServiceStub();
  const healthService = new HealthService(downstreamServiceStub, modelService, logger);

  // Two concurrent calls before the first resolves should share a single
  // in-flight probe rather than each triggering their own fan-out.
  const [first, second] = await Promise.all([
    healthService.getDetailedHealth(),
    healthService.getDetailedHealth()
  ]);
  assert.equal(checkServerHealthCalls, 1, "concurrent callers must share one in-flight probe");
  assert.deepEqual(first, second);

  // A third call still within the TTL window should hit the cache.
  await healthService.getDetailedHealth();
  assert.equal(checkServerHealthCalls, 1, "calls within the TTL must be served from cache");

  // After the TTL window, a fresh probe should occur.
  await new Promise(resolve => setTimeout(resolve, 80));
  await healthService.getDetailedHealth();
  assert.equal(checkServerHealthCalls, 2, "calls after the TTL must trigger a fresh probe");
});

test("getDetailedHealth() bounds a stalled downstream probe with a strict timeout", async () => {
  const states = new Map([["http://slow.test", stateOf("http://slow.test")]]);
  const downstreamServiceStub = {
    getServerStates: () => states,
    getActiveServers: () => Array.from(states.values()),
    // Never resolves - simulates a downstream that ignores its own
    // request timeout (e.g. a DNS-level stall).
    checkServerHealth: () => new Promise(() => {})
  };
  const modelService = modelServiceStub({}, []);
  const healthService = new HealthService(downstreamServiceStub, modelService, logger);

  const start = Date.now();
  const health = await healthService.getDetailedHealth();
  const elapsed = Date.now() - start;

  assert.ok(elapsed < 500, `strict timeout must bound the probe, took ${elapsed}ms`);
  assert.equal(health.downstreams[0].healthy, false);
});