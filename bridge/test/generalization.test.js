const assert = require('node:assert/strict');
const http = require('node:http');
const { afterEach, test } = require('node:test');
const express = require('express');

const { HealthService } = require('../dist/services/health-service');
const { ModelService } = require('../dist/services/model-service');
const { ProxyService } = require('../dist/services/proxy-service');
const { setupDynamicProxyRoutes } = require('../dist/routes/proxy');
const { createXRegistryRoutes } = require('../dist/routes/xregistry');

const logger = new Proxy({}, {
  get: () => () => undefined
});

const servers = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))));
});

async function listen(app) {
  const server = http.createServer(app);
  servers.push(server);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

function request(url) {
  return new Promise((resolve, reject) => {
    http.get(url, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: body ? JSON.parse(body) : undefined
      }));
    }).on('error', reject);
  });
}

function activeState(server, groups, rootResponse = {}) {
  return {
    server,
    isActive: true,
    lastAttempt: Date.now(),
    model: { groups },
    capabilities: {},
    rootResponse
  };
}

function group(plural, resources = {}) {
  return { plural, singular: plural.replace(/s$/, ''), resources };
}

test('root exposes exact cached counts and leaves unknown or partial counts unknown', async () => {
  const backend = { url: 'http://downstream.test' };
  const states = new Map([[
    backend.url,
    activeState(backend, {
      modelregistries: group('modelregistries'),
      datasetregistries: group('datasetregistries'),
      spaceregistries: group('spaceregistries')
    }, {
      modelregistriescount: 2,
      datasetregistriescount: '100+',
      spaceregistriescount: Number.MAX_SAFE_INTEGER + 1
    })
  ]]);

  const modelService = new ModelService(logger);
  modelService.rebuildConsolidatedModel(states);
  const app = express();
  app.use(createXRegistryRoutes(
    modelService,
    { getHealth: async () => ({ status: 'healthy' }), getStatus: () => ({}) },
    { getServerStates: () => states },
    logger
  ));
  const response = await request(await listen(app));

  assert.equal(response.status, 200);
  assert.equal(response.body.modelregistriescount, 2);
  assert.equal('datasetregistriescount' in response.body, false);
  assert.equal('spaceregistriescount' in response.body, false);
});

test('one backend serves multiple groups and forwards nested encoded identifiers unchanged', async () => {
  const downstream = express();
  downstream.use((req, res) => {
    res.json({
      path: req.url,
      versionid: 'a3f18c9107d2f8f90ad3c0d9e8026a85c12e640b',
      alias: 'main'
    });
  });
  const downstreamUrl = await listen(downstream);
  const backend = { url: downstreamUrl };
  const modelService = new ModelService(logger);
  modelService.rebuildConsolidatedModel(new Map([[
    downstreamUrl,
    activeState(backend, {
      terraformregistries: group('terraformregistries', {
        providers: { plural: 'providers', singular: 'provider' },
        modules: { plural: 'modules', singular: 'module' }
      }),
      huggingfaceregistries: group('huggingfaceregistries', {
        models: { plural: 'models', singular: 'model' },
        datasets: { plural: 'datasets', singular: 'dataset' },
        spaces: { plural: 'spaces', singular: 'space' }
      })
    })
  ]]));

  const bridge = express();
  setupDynamicProxyRoutes(bridge, modelService, new ProxyService(logger), logger);
  const bridgeUrl = await listen(bridge);

  const provider = await request(
    `${bridgeUrl}/terraformregistries/public/providers/hashicorp%2Faws/versions/main`
  );
  const model = await request(
    `${bridgeUrl}/huggingfaceregistries/hub/models/org%2Fmodel/versions/a3f18c9107d2f8f90ad3c0d9e8026a85c12e640b`
  );

  assert.equal(provider.status, 200);
  assert.equal(provider.body.path,
    '/terraformregistries/public/providers/hashicorp%2Faws/versions/main');
  assert.equal(model.body.path,
    '/huggingfaceregistries/hub/models/org%2Fmodel/versions/a3f18c9107d2f8f90ad3c0d9e8026a85c12e640b');
  assert.equal(model.body.versionid, 'a3f18c9107d2f8f90ad3c0d9e8026a85c12e640b');
});

test('nested inline requests are delegated to the owning backend', async () => {
  let receivedUrl;
  const downstream = express();
  downstream.get('/huggingfaceregistries', (req, res) => {
    receivedUrl = req.url;
    res.json({ hub: { huggingfaceregistryid: 'hub' } });
  });
  const downstreamUrl = await listen(downstream);
  const backend = { url: downstreamUrl };
  const states = new Map([[
    downstreamUrl,
    activeState(backend, {
      huggingfaceregistries: group('huggingfaceregistries', {
        models: { plural: 'models', singular: 'model' }
      })
    })
  ]]);
  const modelService = new ModelService(logger);
  modelService.rebuildConsolidatedModel(states);

  const bridge = express();
  bridge.use(createXRegistryRoutes(
    modelService,
    { getHealth: async () => ({ status: 'healthy' }), getStatus: () => ({}) },
    { getServerStates: () => states },
    logger
  ));
  const response = await request(
    `${await listen(bridge)}/?inline=huggingfaceregistries.models.versions`
  );

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.huggingfaceregistries,
    { hub: { huggingfaceregistryid: 'hub' } });
  assert.equal(receivedUrl, '/huggingfaceregistries?inline=models.versions');
});

test('failed inline requests preserve the collection shape and add a warning', async () => {
  const downstream = express();
  downstream.get('/modelregistries', (_req, res) => {
    res.status(503).json({ error: 'unavailable' });
  });
  const downstreamUrl = await listen(downstream);
  const backend = { url: downstreamUrl };
  const states = new Map([[
    downstreamUrl,
    activeState(backend, {
      modelregistries: group('modelregistries')
    })
  ]]);
  const modelService = new ModelService(logger);
  modelService.rebuildConsolidatedModel(states);

  const bridge = express();
  bridge.use(createXRegistryRoutes(
    modelService,
    { getHealth: async () => ({ status: 'healthy' }), getStatus: () => ({}) },
    { getServerStates: () => states },
    logger
  ));
  const response = await request(`${await listen(bridge)}/?inline=modelregistries`);

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.modelregistries, {});
  assert.match(response.headers.warning, /Unable to inline modelregistries/);
});

test('group collisions are deterministic and disabled rather than routed', async () => {
  const first = { url: 'http://z-backend.test' };
  const second = { url: 'http://a-backend.test' };
  const states = new Map([
    [first.url, activeState(first, { sharedregistries: group('sharedregistries') })],
    [second.url, activeState(second, { sharedregistries: group('sharedregistries') })]
  ]);
  const modelService = new ModelService(logger);

  assert.equal(modelService.rebuildConsolidatedModel(states), true);
  assert.equal(modelService.getBackendForGroup('sharedregistries'), undefined);
  assert.equal(modelService.getConsolidatedModel().groups.sharedregistries, undefined);
  assert.deepEqual(modelService.getGroupCollisions(), [{
    groupType: 'sharedregistries',
    servers: ['http://a-backend.test', 'http://z-backend.test']
  }]);
  const healthService = new HealthService({
    getServerStates: () => states,
    getActiveServers: () => Array.from(states.values()),
    checkServerHealth: async () => true
  }, modelService, logger);
  assert.equal((await healthService.getHealth()).status, 'degraded');

  const bridge = express();
  setupDynamicProxyRoutes(bridge, modelService, new ProxyService(logger), logger);
  bridge.use((_req, res) => res.status(404).json({ error: 'not routed' }));
  const response = await request(`${await listen(bridge)}/sharedregistries`);
  assert.equal(response.status, 404);
});
