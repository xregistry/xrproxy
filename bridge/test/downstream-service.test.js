"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");

process.env.ROOT_METADATA_TIMEOUT = "50";

const { DownstreamService } = require("../dist/services/downstream-service");

const logger = {
  debug() {},
  error() {},
  info() {},
  warn() {},
};

test("activates a downstream when optional root metadata times out", async (t) => {
  const server = http.createServer((req, res) => {
    if (req.url === "/model") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ groups: { composerregistries: {} } }));
      return;
    }
    if (req.url === "/capabilities") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ apis: ["/model", "/capabilities"] }));
      return;
    }
    setTimeout(() => {
      if (!res.destroyed) res.end(JSON.stringify({ composerregistriescount: 1 }));
    }, 200);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));

  const address = server.address();
  const downstream = { url: `http://127.0.0.1:${address.port}` };
  const service = new DownstreamService([downstream], logger);
  const result = await service.testServer(downstream);

  assert.ok(result);
  assert.deepEqual(Object.keys(result.model.groups), ["composerregistries"]);
  assert.equal(result.rootResponse, undefined);
});
