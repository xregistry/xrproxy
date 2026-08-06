"use strict";

// This flag must be set BEFORE requiring any dist module that (transitively)
// imports src/config/constants.ts, since ENABLE_BODY_URL_REWRITE is read
// once at module load time.
process.env.ENABLE_BODY_URL_REWRITE = "true";

const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const express = require("express");

const { ModelService } = require("../dist/services/model-service");
const { ProxyService } = require("../dist/services/proxy-service");
const { setupDynamicProxyRoutes } = require("../dist/routes/proxy");
const constants = require("../dist/config/constants");

const logger = { debug() {}, error() {}, info() {}, warn() {} };
const servers = [];

test.afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))));
});

async function listen(app) {
  const server = http.createServer(app);
  servers.push(server);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

function request(url) {
  return new Promise((resolve, reject) => {
    http.get(url, response => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { body += chunk; });
      response.on("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: body ? JSON.parse(body) : undefined
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

test("ENABLE_BODY_URL_REWRITE=true rewrites downstream-absolute URLs in JSON bodies", async () => {
  assert.equal(constants.ENABLE_BODY_URL_REWRITE, true, "test setup sanity check");

  const downstream = express();
  downstream.get("/widgetregistries", (_req, res) => {
    res.json({
      self: `${downstreamUrlValue}/widgetregistries`,
      widgetregistryid: "w1",
      xid: `${downstreamUrlValue}/widgetregistries/w1`
    });
  });
  let downstreamUrlValue = await listen(downstream);
  downstream._addr = downstreamUrlValue; // not used, just for clarity

  const backend = { url: downstreamUrlValue };
  const modelService = new ModelService(logger);
  modelService.rebuildConsolidatedModel(new Map([[downstreamUrlValue, activeState(backend, {
    widgetregistries: group("widgetregistries")
  })]]));

  const bridge = express();
  setupDynamicProxyRoutes(bridge, modelService, new ProxyService(logger), logger);
  const bridgeUrl = await listen(bridge);

  const response = await request(`${bridgeUrl}/widgetregistries`);

  assert.equal(response.status, 200);
  // "self" is rewritten to the bridge's own base URL...
  assert.equal(response.body.self, `${bridgeUrl}/widgetregistries`);
  // ...but "xid" is preserved verbatim - it is a canonical identifier, not
  // a URL to rewrite.
  assert.equal(response.body.xid, `${downstreamUrlValue}/widgetregistries/w1`);
});