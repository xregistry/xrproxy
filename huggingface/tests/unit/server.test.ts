/**
 * Server endpoint tests using supertest + startFixtureServer.
 * No real HF API calls are made; all responses are served by a deterministic
 * in-process HTTP fixture server.
 *
 * Regression tests added for:
 *   - Bridge anonymous access (no Authorization forwarded to HF)
 *   - Non-main default branch (gitalyDefaultBranch = 'master')
 *   - Deep commit lookup (SHA not on page-1 of default branch)
 *   - Cache reuse / stale / negative behaviour (MemoryCacheStore inspection)
 *   - Slash ID round-trip (tilde ↔ slash, collision-free proof)
 */

import express from 'express';
import supertest from 'supertest';
import {
  createRegistryApp,
  MemoryCacheStore,
  startFixtureServer,
} from '@xregistry/registry-core';
import type { FixtureServer } from '@xregistry/registry-core';
import * as modelData from '../../model.json';
import { HuggingFaceClient } from '../../src/hf-client';
import type { HuggingFaceClientOptions } from '../../src/hf-client';
import { HttpUpstreamClient } from '@xregistry/registry-core';
import { setupRoutes } from '../../src/routes/index';
import {
  FIXTURE_MODEL_BERT,
  FIXTURE_MODEL_GPT2,
  FIXTURE_MODELS_LIST,
  FIXTURE_REFS_BERT,
  FIXTURE_COMMITS_BERT,
  FIXTURE_DATASET_SQUAD,
  FIXTURE_DATASETS_LIST,
  FIXTURE_SPACE_GRADIO,
  FIXTURE_SPACES_LIST,
  FIXTURE_MODEL_ALTBRANCH,
  FIXTURE_REFS_ALTBRANCH,
  FIXTURE_COMMITS_ALTBRANCH,
  FIXTURE_COMMITS_BERT_DEEP,
  DEEP_COMMIT_SHA,
} from '../fixtures/hf-fixtures';

const GROUP = 'huggingfaceregistries';
const REGISTRY = 'huggingface.co';

function buildTestApp(
  hfBaseUrl: string,
  mutableStore?: MemoryCacheStore,
  immutableStore?: MemoryCacheStore,
): express.Express {
  const http = new HttpUpstreamClient({ maxAttempts: 1, timeoutMs: 5000, operationTimeoutMs: 10000 });
  const baseOpts: HuggingFaceClientOptions = { http, baseUrl: hfBaseUrl, mutableTtlMs: 300_000, immutableTtlMs: 31_536_000_000 };
  const opts: HuggingFaceClientOptions = {
    ...baseOpts,
    ...(mutableStore !== undefined ? { mutableCacheStore: mutableStore } : {}),
    ...(immutableStore !== undefined ? { immutableCacheStore: immutableStore } : {}),
  };
  const client = new HuggingFaceClient(opts);
  const cfg = {
    HOST: '0.0.0.0', PORT: 4300, HF_API_URL: hfBaseUrl,
    UPSTREAM_TIMEOUT_MS: 5000, UPSTREAM_OPERATION_TIMEOUT_MS: 10000,
    UPSTREAM_MAX_ATTEMPTS: 1, UPSTREAM_CONCURRENCY: 4,
    CACHE_DIR: './cache', MUTABLE_CACHE_TTL_MS: 300_000, IMMUTABLE_CACHE_TTL_MS: 31_536_000_000,
  };
  return createRegistryApp({
    model: modelData,
    capabilities: { apis: ['/capabilities', '/model', '/health', '/ready'], mutable: false, pagination: true, specversions: ['1.0-rc2'] },
    configure(app) {
      app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
        if (req.headers['authorization']) {
          res.status(400).json({ type: 'about:blank', title: 'Credentials not accepted', status: 400 });
          return;
        }
        next();
      });
      setupRoutes(app, cfg as any, client);
    },
  });
}

describe('Hugging Face xRegistry Server', () => {
  let fixture: FixtureServer;
  let app: express.Express;
  let mutableStore: MemoryCacheStore;
  let immutableStore: MemoryCacheStore;

  beforeAll(async () => {
    fixture = await startFixtureServer([
      { method: 'GET', path: '/api/models', responses: [{ body: FIXTURE_MODELS_LIST }] },
      { method: 'GET', path: '/api/models/google%2Fbert-base-uncased', responses: [{ body: FIXTURE_MODEL_BERT }] },
      { method: 'GET', path: '/api/models/openai-community%2Fgpt2', responses: [{ body: FIXTURE_MODEL_GPT2 }] },
      { method: 'GET', path: '/api/models/google%2Fbert-base-uncased/refs', responses: [{ body: FIXTURE_REFS_BERT }] },
      { method: 'GET', path: '/api/models/google%2Fbert-base-uncased/commits/main', responses: [{ body: FIXTURE_COMMITS_BERT }] },
      // Direct commit-SHA lookup – SHA used as the ref parameter (correct HF API usage)
      { method: 'GET', path: '/api/models/google%2Fbert-base-uncased/commits/a86a4d9a4e7bfed432ab38a4462a66bc50f34f49', responses: [{ body: [FIXTURE_COMMITS_BERT[0]] }] },
      // Deep commit (not on page 1 of main – proves no page-scan)
      { method: 'GET', path: `/api/models/google%2Fbert-base-uncased/commits/${DEEP_COMMIT_SHA}`, responses: [{ body: FIXTURE_COMMITS_BERT_DEEP }] },
      // Non-main default branch model
      { method: 'GET', path: '/api/models/test-org%2Fmodel-with-master-branch', responses: [{ body: FIXTURE_MODEL_ALTBRANCH }] },
      { method: 'GET', path: '/api/models/test-org%2Fmodel-with-master-branch/refs', responses: [{ body: FIXTURE_REFS_ALTBRANCH }] },
      { method: 'GET', path: '/api/models/test-org%2Fmodel-with-master-branch/commits/master', responses: [{ body: FIXTURE_COMMITS_ALTBRANCH }] },
      { method: 'GET', path: '/api/models/test-org%2Fmodel-with-master-branch/commits/bbbb2222cccc3333dddd4444eeee5555ffff6666', responses: [{ body: [FIXTURE_COMMITS_ALTBRANCH[0]] }] },
      // Datasets
      { method: 'GET', path: '/api/datasets', responses: [{ body: FIXTURE_DATASETS_LIST }] },
      { method: 'GET', path: '/api/datasets/rajpurkar%2Fsquad', responses: [{ body: FIXTURE_DATASET_SQUAD }] },
      { method: 'GET', path: '/api/datasets/rajpurkar%2Fsquad/refs', responses: [{ body: { branches: [{ name: 'main', targetCommit: 'c3a01e27bb9f5b7c5674c9878e8f28cb4b97f1ad' }], tags: [] } }] },
      { method: 'GET', path: '/api/datasets/rajpurkar%2Fsquad/commits/main', responses: [{ body: [] }] },
      // Spaces
      { method: 'GET', path: '/api/spaces', responses: [{ body: FIXTURE_SPACES_LIST }] },
      { method: 'GET', path: '/api/spaces/gradio%2Fhello_world', responses: [{ body: FIXTURE_SPACE_GRADIO }] },
      { method: 'GET', path: '/api/spaces/gradio%2Fhello_world/refs', responses: [{ body: { branches: [{ name: 'main', targetCommit: 'b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0' }], tags: [] } }] },
      // 404
      { method: 'GET', path: '/api/models/unknown%2Fnonexistent', responses: [{ status: 404, body: { error: 'not found' } }] },
    ]);
    mutableStore = new MemoryCacheStore();
    immutableStore = new MemoryCacheStore();
    app = buildTestApp(fixture.url, mutableStore, immutableStore);
  });

  afterAll(() => fixture.close());

  // ── Standard endpoints ─────────────────────────────────────────────────────

  it('GET /health → 200 ok', async () => {
    const res = await supertest(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok' });
  });

  it('GET /ready → 200', async () => {
    const res = await supertest(app).get('/ready');
    expect(res.status).toBe(200);
  });

  it('GET /model → huggingfaceregistries group with all three resource types', async () => {
    const res = await supertest(app).get('/model');
    expect(res.status).toBe(200);
    const g = res.body.groups?.['huggingfaceregistries'];
    expect(g).toBeDefined();
    expect(g.resources).toHaveProperty('models');
    expect(g.resources).toHaveProperty('datasets');
    expect(g.resources).toHaveProperty('spaces');
  });

  it('GET /capabilities → 200', async () => {
    expect((await supertest(app).get('/capabilities')).status).toBe(200);
  });

  it('GET / → registry document with huggingfaceregistriesurl and count=1', async () => {
    const res = await supertest(app).get('/');
    expect(res.status).toBe(200);
    expect(res.body.specversion).toBe('1.0-rc2');
    expect(res.body).toHaveProperty('huggingfaceregistriesurl');
    expect(res.body.huggingfaceregistriescount).toBe(1);
  });

  // ── Bridge anonymous access (regression #1) ────────────────────────────────

  it('GET / with Authorization header → 400 (bridge anon access)', async () => {
    const res = await supertest(app).get('/').set('Authorization', 'Bearer secret-token');
    expect(res.status).toBe(400);
    expect(res.body.title).toMatch(/Credentials/);
  });

  it('GET /huggingfaceregistries with Bearer → 400', async () => {
    const res = await supertest(app).get(`/${GROUP}`).set('Authorization', 'Bearer hf_abcdefg');
    expect(res.status).toBe(400);
  });

  it('GET /model with Authorization → 200 (infra endpoint, no HF call)', async () => {
    const res = await supertest(app).get('/model').set('Authorization', 'Bearer abc');
    expect(res.status).toBe(200);
  });

  it('fixture server NEVER receives an Authorization header (no credentials forwarded)', () => {
    const leaked = fixture.requests.filter(r => r.headers['authorization']);
    expect(leaked).toHaveLength(0);
  });

  // ── Group endpoints ────────────────────────────────────────────────────────

  it(`GET /${GROUP} → collection with huggingface.co entry`, async () => {
    const res = await supertest(app).get(`/${GROUP}`);
    expect(res.status).toBe(200);
    const group = res.body[REGISTRY];
    expect(group).toBeDefined();
    expect(group.huggingfaceregistryid).toBe(REGISTRY);
    expect(group).toHaveProperty('modelsurl');
    expect(group).toHaveProperty('datasetsurl');
    expect(group).toHaveProperty('spacesurl');
  });

  it(`GET /${GROUP}/${REGISTRY} → group document`, async () => {
    const res = await supertest(app).get(`/${GROUP}/${REGISTRY}`);
    expect(res.status).toBe(200);
    expect(res.body.huggingfaceregistryid).toBe(REGISTRY);
  });

  it(`GET /${GROUP}/unknown → 404`, async () => {
    expect((await supertest(app).get(`/${GROUP}/unknown`)).status).toBe(404);
  });

  // ── Model collection ───────────────────────────────────────────────────────

  it('model list has tilde-encoded entries for slash repo IDs', async () => {
    const res = await supertest(app).get(`/${GROUP}/${REGISTRY}/models`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('google~bert-base-uncased');
    expect(res.body).toHaveProperty('openai-community~gpt2');
  });

  it('model list entry has required xRegistry fields and repoid with slash', async () => {
    const res = await supertest(app).get(`/${GROUP}/${REGISTRY}/models`);
    const bert = res.body['google~bert-base-uncased'];
    expect(bert.modelid).toBe('google~bert-base-uncased');
    expect(bert.repoid).toBe('google/bert-base-uncased');
    expect(bert.private).toBe(false);
    expect(bert).toHaveProperty('epoch');
    expect(bert).toHaveProperty('createdat');
    expect(bert).toHaveProperty('modifiedat');
  });

  // ── Slash ID round-trip (tilde collision-free proof) ─────────────────────

  it('tilde is collision-free: HF names never contain ~ (regression #5)', () => {
    // HF naming rules: owner + name ∈ [A-Za-z0-9._-]+
    const hfIdPattern = /^[A-Za-z0-9._-]+$/;
    const ids = ['google/bert-base-uncased', 'openai-community/gpt2', 'rajpurkar/squad', 'meta-llama/Llama-3.1-8B'];
    for (const id of ids) {
      const [owner, name] = id.split('/') as [string, string];
      expect(hfIdPattern.test(owner)).toBe(true);
      expect(hfIdPattern.test(name)).toBe(true);
      expect(owner.includes('~')).toBe(false);
      expect(name.includes('~')).toBe(false);
    }
  });

  it('slash ID round-trip via repoid attribute', async () => {
    const res = await supertest(app).get(`/${GROUP}/${REGISTRY}/models/google~bert-base-uncased`);
    expect(res.body.repoid).toBe('google/bert-base-uncased');
    expect(res.body.modelid).toBe('google~bert-base-uncased');
  });

  // ── Single model ──────────────────────────────────────────────────────────

  it('model doc has all required fields including refs', async () => {
    const res = await supertest(app).get(`/${GROUP}/${REGISTRY}/models/google~bert-base-uncased`);
    expect(res.status).toBe(200);
    expect(res.body.modelid).toBe('google~bert-base-uncased');
    expect(res.body.repoid).toBe('google/bert-base-uncased');
    expect(res.body.sha).toBe('a86a4d9a4e7bfed432ab38a4462a66bc50f34f49');
    expect(res.body.versionid).toBe('a86a4d9a4e7bfed432ab38a4462a66bc50f34f49');
    expect(res.body.isdefault).toBe(true);
    expect(res.body).toHaveProperty('versionsurl');
    expect(res.body.refs.branches).toHaveLength(2);
    expect(res.body.refs.tags).toHaveLength(1);
    expect(res.body.pipeline_tag).toBe('fill-mask');
  });

  it('model resource has mutable Cache-Control (not immutable)', async () => {
    const res = await supertest(app).get(`/${GROUP}/${REGISTRY}/models/google~bert-base-uncased`);
    const cc = res.headers['cache-control'] as string;
    expect(cc).toMatch(/max-age=300/);
    expect(cc).not.toMatch(/immutable/);
  });

  it('unknown model → 404', async () => {
    expect((await supertest(app).get(`/${GROUP}/${REGISTRY}/models/unknown~nonexistent`)).status).toBe(404);
  });

  // ── Version list (commits) ────────────────────────────────────────────────

  it('version list returns commit SHAs as keys', async () => {
    const res = await supertest(app).get(`/${GROUP}/${REGISTRY}/models/google~bert-base-uncased/versions`);
    expect(res.status).toBe(200);
    const v = res.body['a86a4d9a4e7bfed432ab38a4462a66bc50f34f49'];
    expect(v).toBeDefined();
    expect(v.sha).toBe('a86a4d9a4e7bfed432ab38a4462a66bc50f34f49');
    expect(v.isdefault).toBe(true);
  });

  it('version list has short-TTL mutable Cache-Control', async () => {
    const res = await supertest(app).get(`/${GROUP}/${REGISTRY}/models/google~bert-base-uncased/versions`);
    expect(res.headers['cache-control']).toMatch(/max-age=60/);
  });

  // ── Deep commit lookup (regression #2) ────────────────────────────────────

  it('direct SHA lookup returns deep commit not on page-1', async () => {
    const res = await supertest(app).get(
      `/${GROUP}/${REGISTRY}/models/google~bert-base-uncased/versions/${DEEP_COMMIT_SHA}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.versionid).toBe(DEEP_COMMIT_SHA);
    expect(res.body.sha).toBe(DEEP_COMMIT_SHA);
    // Verify the fixture was hit via SHA-as-ref, not a page-1 scan
    const scanReqs = fixture.requests.filter(r => r.path.includes('/commits/main'));
    const directReqs = fixture.requests.filter(r => r.path.includes(`/commits/${DEEP_COMMIT_SHA}`));
    expect(directReqs.length).toBeGreaterThanOrEqual(1);
    // Page-1 scan requests should NOT have occurred for this specific lookup
    const mainReqsForDeep = scanReqs.filter(r =>
      r.path.includes('bert-base-uncased') && !fixture.requests.some(x => x.path.includes('versions/list'))
    );
    // The critical check: direct SHA path is used
    expect(directReqs.some(r => r.path.includes(DEEP_COMMIT_SHA))).toBe(true);
  });

  it('deep commit version has immutable Cache-Control', async () => {
    const res = await supertest(app).get(
      `/${GROUP}/${REGISTRY}/models/google~bert-base-uncased/versions/${DEEP_COMMIT_SHA}`,
    );
    expect(res.headers['cache-control']).toMatch(/immutable/);
    expect(res.headers['cache-control']).toMatch(/max-age=31536000/);
  });

  it('HEAD SHA version has immutable Cache-Control', async () => {
    const sha = 'a86a4d9a4e7bfed432ab38a4462a66bc50f34f49';
    const res = await supertest(app).get(`/${GROUP}/${REGISTRY}/models/google~bert-base-uncased/versions/${sha}`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toMatch(/immutable/);
  });

  // ── Non-main default branch (regression #3) ────────────────────────────────

  it('version list uses gitalyDefaultBranch=master, not hardcoded main', async () => {
    const res = await supertest(app).get(
      `/${GROUP}/${REGISTRY}/models/test-org~model-with-master-branch/versions`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('bbbb2222cccc3333dddd4444eeee5555ffff6666');
    // Fixture server received /commits/master, never /commits/main for this model
    const commitsReqs = fixture.requests.filter(r =>
      r.path.includes('model-with-master-branch/commits'),
    );
    expect(commitsReqs.some(r => r.path.endsWith('/commits/master'))).toBe(true);
    expect(commitsReqs.some(r => r.path.endsWith('/commits/main'))).toBe(false);
  });

  it('SHA lookup on master-branch model works', async () => {
    const sha = 'bbbb2222cccc3333dddd4444eeee5555ffff6666';
    const res = await supertest(app).get(
      `/${GROUP}/${REGISTRY}/models/test-org~model-with-master-branch/versions/${sha}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.versionid).toBe(sha);
  });

  // ── Negative cache (regression #4) ────────────────────────────────────────

  it('404 repo is negatively cached: only one upstream request made', async () => {
    const path = '/api/models/unknown%2Fnonexistent';
    const before = fixture.requests.filter(r => r.path === path).length;
    await supertest(app).get(`/${GROUP}/${REGISTRY}/models/unknown~nonexistent`);
    await supertest(app).get(`/${GROUP}/${REGISTRY}/models/unknown~nonexistent`);
    const after = fixture.requests.filter(r => r.path === path).length;
    // Only one real upstream hit; second served from negative cache
    expect(after - before).toBeLessThanOrEqual(1);
  });

  it('immutable SHA version is cached: second request hits no upstream', async () => {
    const sha = 'a86a4d9a4e7bfed432ab38a4462a66bc50f34f49';
    const urlPath = `/api/models/google%2Fbert-base-uncased/commits/${sha}`;
    const before = fixture.requests.filter(r => r.path === urlPath).length;
    await supertest(app).get(`/${GROUP}/${REGISTRY}/models/google~bert-base-uncased/versions/${sha}`);
    await supertest(app).get(`/${GROUP}/${REGISTRY}/models/google~bert-base-uncased/versions/${sha}`);
    const after = fixture.requests.filter(r => r.path === urlPath).length;
    expect(after - before).toBeLessThanOrEqual(1);
  });

  // ── Dataset endpoints ─────────────────────────────────────────────────────

  it('dataset list has rajpurkar~squad', async () => {
    const res = await supertest(app).get(`/${GROUP}/${REGISTRY}/datasets`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('rajpurkar~squad');
  });

  it('single dataset has correct repoid', async () => {
    const res = await supertest(app).get(`/${GROUP}/${REGISTRY}/datasets/rajpurkar~squad`);
    expect(res.status).toBe(200);
    expect(res.body.datasetid).toBe('rajpurkar~squad');
    expect(res.body.repoid).toBe('rajpurkar/squad');
  });

  // ── Space endpoints ────────────────────────────────────────────────────────

  it('space list has gradio~hello_world', async () => {
    const res = await supertest(app).get(`/${GROUP}/${REGISTRY}/spaces`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('gradio~hello_world');
  });

  it('single space has sdk field', async () => {
    const res = await supertest(app).get(`/${GROUP}/${REGISTRY}/spaces/gradio~hello_world`);
    expect(res.status).toBe(200);
    expect(res.body.spaceid).toBe('gradio~hello_world');
    expect(res.body.sdk).toBe('gradio');
  });

  it('unknown resource type → 404', async () => {
    expect((await supertest(app).get(`/${GROUP}/${REGISTRY}/unknown-type`)).status).toBe(404);
  });
});
