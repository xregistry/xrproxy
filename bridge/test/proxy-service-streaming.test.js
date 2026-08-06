"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const express = require("express");

const { ModelService } = require("../dist/services/model-service");
const { ProxyService } = require("../dist/services/proxy-service");
const { setupDynamicProxyRoutes } = require("../dist/routes/proxy");

const logger = { debug() {}, error() {}, info() {}, warn() {} };
const servers = [];

test.afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))));
});

async function listen(app) {
  const server = http.createServer(app);
  servers.push(server);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, server };
}

function rawGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, response => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { body += chunk; });
      response.on("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body
      }));
    }).on("error", reject);
  });
}

function activeState(server, groups) {
  return {
    server,
    isActive: true,
    lastAttempt: Date.now(),
    model: { groups },
    capabilities: {},
    rootResponse: {}
  };
}

function group(plural) {
  return { plural, singular: plural.replace(/s$/, ""), resources: {} };
}

test("default (ENABLE_BODY_URL_REWRITE unset) streams JSON responses through unchanged", async () => {
  assert.notEqual(process.env.ENABLE_BODY_URL_REWRITE, "true");

  const downstream = express();
  downstream.get("/widgetregistries", (req, res) => {
    res.status(201);
    res.setHeader("x-custom-header", "downstream-value");
    res.setHeader("link", `<${downstreamUrl()}/widgetregistries?page=2>; rel="next"`);
    res.json({ self: `${downstreamUrl()}/widgetregistries`, widgetregistryid: "w1" });
  });

  let downstreamUrlValue;
  function downstreamUrl() { return downstreamUrlValue; }

  const { url: dUrl } = await listen(downstream);
  downstreamUrlValue = dUrl;

  const backend = { url: dUrl };
  const modelService = new ModelService(logger);
  modelService.rebuildConsolidatedModel(new Map([[dUrl, activeState(backend, {
    widgetregistries: group("widgetregistries")
  })]]));

  const bridge = express();
  setupDynamicProxyRoutes(bridge, modelService, new ProxyService(logger), logger);
  const { url: bridgeUrl } = await listen(bridge);

  const response = await rawGet(`${bridgeUrl}/widgetregistries`);
  const expectedBody = JSON.stringify({ self: `${dUrl}/widgetregistries`, widgetregistryid: "w1" });

  // Status and custom headers preserved as-is.
  assert.equal(response.status, 201);
  assert.equal(response.headers["x-custom-header"], "downstream-value");

  // Body is streamed through untouched: still contains the raw downstream
  // URL because no buffering/parsing/re-serialization happened, and the
  // byte length matches the original exactly (proves it wasn't rewritten).
  assert.equal(response.body, expectedBody);
  assert.equal(response.headers["content-length"], String(Buffer.byteLength(expectedBody)));

  // Link header is still rewritten safely (cheap, header-only operation)
  // even though the body was left alone.
  assert.ok(!response.headers.link.includes(dUrl), "Link header must not leak the downstream URL");
  assert.match(response.headers.link, /rel="next"/);
});

test("non-JSON responses are always streamed through (status/headers preserved)", async () => {
  const downstream = express();
  downstream.get("/widgetregistries/blob", (_req, res) => {
    res.status(206);
    res.setHeader("content-type", "text/plain");
    res.send("binary-ish payload");
  });
  const { url: dUrl } = await listen(downstream);

  const backend = { url: dUrl };
  const modelService = new ModelService(logger);
  modelService.rebuildConsolidatedModel(new Map([[dUrl, activeState(backend, {
    widgetregistries: group("widgetregistries")
  })]]));

  const bridge = express();
  setupDynamicProxyRoutes(bridge, modelService, new ProxyService(logger), logger);
  const { url: bridgeUrl } = await listen(bridge);

  const response = await rawGet(`${bridgeUrl}/widgetregistries/blob`);
  assert.equal(response.status, 206);
  assert.equal(response.body, "binary-ish payload");
});

test("Link header without a downstream URL is left untouched", async () => {
  const downstream = express();
  downstream.get("/widgetregistries", (_req, res) => {
    res.setHeader("link", '<https://unrelated.example/next>; rel="next"');
    res.json({ ok: true });
  });
  const { url: dUrl } = await listen(downstream);

  const backend = { url: dUrl };
  const modelService = new ModelService(logger);
  modelService.rebuildConsolidatedModel(new Map([[dUrl, activeState(backend, {
    widgetregistries: group("widgetregistries")
  })]]));

  const bridge = express();
  setupDynamicProxyRoutes(bridge, modelService, new ProxyService(logger), logger);
  const { url: bridgeUrl } = await listen(bridge);

  const response = await rawGet(`${bridgeUrl}/widgetregistries`);
  assert.equal(response.headers.link, '<https://unrelated.example/next>; rel="next"');
});