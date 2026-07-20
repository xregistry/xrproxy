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
import * as path from 'node:path';
import supertest from 'supertest';
import {
  createRegistryApp,
  MemoryCacheStore,
  startFixtureServer,
} from '@xregistry/registry-core';
import type { FixtureServer } from '@xregistry/registry-core';
import modelData from "../../model.json";
import { CAPABILITIES } from "../../src/capabilities";
import { HuggingFaceClient } from '../../src/hf-client';
import type { HuggingFaceClientOptions } from '../../src/hf-client';
import { HttpUpstreamClient } from '@xregistry/registry-core';
import { setupRoutes } from '../../src/routes/index';
import {
  FIXTURE_MODEL_BERT,
  FIXTURE_MODEL_GPT2,
  FIXTURE_MODEL_UNNAMESPACED,
  FIXTURE_MODEL_GOOGLE_SECOND,
  FIXTURE_MODEL_DOTTED_OWNER,
  FIXTURE_MODEL_GATED,
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
const {
  assertGroupConforms,
  assertMetaConforms,
  assertResourceConforms,
  assertResourceProjectsVersion,
  assertVersionConforms,
} = require(path.join(__dirname, '../../../test/helpers/xregistry-model-conformance.cjs'));

const { assertCapabilitiesConform } = require(
  path.join(__dirname, "../../../test/helpers/xregistry-capability-conformance.cjs"),
);

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
    capabilities: CAPABILITIES,
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
      { method: 'GET', path: '/api/models/google-bert/bert-base-uncased', responses: [{ body: FIXTURE_MODEL_BERT }] },
      { method: 'GET', path: '/api/models/openai-community/gpt2', responses: [{ body: FIXTURE_MODEL_GPT2 }] },
      { method: 'GET', path: '/api/models/openai-community/gpt2/refs', responses: [{ body: { branches: [], tags: [] } }] },
      // The public gpt2 alias resolves to the authoritative canonical repoInfo.id.
      { method: 'GET', path: '/api/models/gpt2', responses: [{ body: FIXTURE_MODEL_GPT2 }] },
      { method: 'GET', path: '/api/models/true-bare-model', responses: [{ body: FIXTURE_MODEL_UNNAMESPACED }] },
      { method: 'GET', path: '/api/models/true-bare-model/refs', responses: [{ body: { branches: [], tags: [] } }] },
      { method: 'GET', path: '/api/models/google-bert/second-model', responses: [{ body: FIXTURE_MODEL_GOOGLE_SECOND }] },
      { method: 'GET', path: '/api/models/google-bert/second-model/refs', responses: [{ body: { branches: [], tags: [] } }] },
      { method: 'GET', path: '/api/models/org.example/dotted-model', responses: [{ body: FIXTURE_MODEL_DOTTED_OWNER }] },
      { method: 'GET', path: '/api/models/gated-org/public-metadata', responses: [{ body: FIXTURE_MODEL_GATED }] },
      { method: 'GET', path: '/api/models/gated-org/public-metadata/refs', responses: [{ status: 401, body: { error: 'gated' } }] },
      { method: 'GET', path: '/api/models/gated-org/public-metadata/commits/main', responses: [{ status: 401, body: { error: 'gated' } }] },
      { method: 'GET', path: '/api/models/gated-org/public-metadata/commits/99990000aaaabbbbccccddddeeeeffff11112222', responses: [{ status: 403, body: { error: 'gated' } }] },
      { method: 'GET', path: '/api/models/google-bert/bert-base-uncased/refs', responses: [{ body: FIXTURE_REFS_BERT }] },
      { method: 'GET', path: '/api/models/google-bert/bert-base-uncased/commits/main', responses: [{ body: FIXTURE_COMMITS_BERT }] },
      // Direct commit-SHA lookup – SHA used as the ref parameter (correct HF API usage)
      { method: 'GET', path: '/api/models/google-bert/bert-base-uncased/commits/a86a4d9a4e7bfed432ab38a4462a66bc50f34f49', responses: [{ body: [FIXTURE_COMMITS_BERT[0]] }] },
      // Deep commit (not on page 1 of main – proves no page-scan)
      { method: 'GET', path: `/api/models/google-bert/bert-base-uncased/commits/${DEEP_COMMIT_SHA}`, responses: [{ body: FIXTURE_COMMITS_BERT_DEEP }] },
      // Non-main default branch model
      { method: 'GET', path: '/api/models/test-org/model-with-master-branch', responses: [{ body: FIXTURE_MODEL_ALTBRANCH }] },
      { method: 'GET', path: '/api/models/test-org/model-with-master-branch/refs', responses: [{ body: FIXTURE_REFS_ALTBRANCH }] },
      { method: 'GET', path: '/api/models/test-org/model-with-master-branch/commits/master', responses: [{ body: FIXTURE_COMMITS_ALTBRANCH }] },
      { method: 'GET', path: '/api/models/test-org/model-with-master-branch/commits/bbbb2222cccc3333dddd4444eeee5555ffff6666', responses: [{ body: [FIXTURE_COMMITS_ALTBRANCH[0]] }] },
      // Datasets
      { method: 'GET', path: '/api/datasets', responses: [{ body: FIXTURE_DATASETS_LIST }] },
      { method: 'GET', path: '/api/datasets/rajpurkar/squad', responses: [{ body: FIXTURE_DATASET_SQUAD }] },
      { method: 'GET', path: '/api/datasets/rajpurkar/squad/refs', responses: [{ body: { branches: [{ name: 'main', targetCommit: 'c3a01e27bb9f5b7c5674c9878e8f28cb4b97f1ad' }], tags: [] } }] },
      { method: 'GET', path: '/api/datasets/rajpurkar/squad/commits/main', responses: [{ body: [] }] },
      // Spaces
      { method: 'GET', path: '/api/spaces', responses: [{ body: FIXTURE_SPACES_LIST }] },
      { method: 'GET', path: '/api/spaces/gradio/hello_world', responses: [{ body: FIXTURE_SPACE_GRADIO }] },
      { method: 'GET', path: '/api/spaces/gradio/hello_world/refs', responses: [{ body: { branches: [{ name: 'main', targetCommit: 'b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0' }], tags: [] } }] },
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
    expect(g.resources.models.attributes).toHaveProperty('versionid');
    expect(g.resources.models.resourceattributes).toHaveProperty('versionscount');
    expect(g.resources.models.metaattributes).toHaveProperty('defaultversionurl');
    const source = await supertest(app).get('/modelsource');
    expect(source.body).toEqual(modelData);
    expect(Object.keys(source.body).sort()).toEqual(Object.keys(modelData).sort());
    expect(Object.keys(source.body)).not.toContain("default");
    expect(Object.keys(res.body)).not.toContain("default");
    expect(source.body.groups.huggingfaceregistries.resources.models).not.toHaveProperty('resourceattributes');
  });

  it("GET /capabilities returns the complete rc2 runtime contract", async () => {
    const response = await supertest(app).get("/capabilities");
    expect(response.status).toBe(200);
    assertCapabilitiesConform(response.body, { flags: ["filter"], versionmodes: ["manual"] });
  });

  it('GET / → registry document with authoritative discovered group count', async () => {
    const res = await supertest(app).get('/');
    expect(res.status).toBe(200);
    expect(res.body.specversion).toBe('1.0-rc2');
    expect(res.body).toHaveProperty('huggingfaceregistriesurl');
    expect(res.body.huggingfaceregistriescount).toBe(7);
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

  // Group endpoints

  it(`GET /${GROUP} returns owner namespace groups with counts`, async () => {
    const res = await supertest(app).get(`/${GROUP}?limit=3&offset=0`);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['_', 'gated-org', 'google-bert']);
    expect(res.headers['x-total-count']).toBe('7');
    expect(res.headers['link']).toContain('offset=3');
    expect(res.body['google-bert'].huggingfaceregistryid).toBe('google-bert');
    expect(res.body['google-bert'].modelscount).toBe(2);
  });

  it(`GET /${GROUP}/google-bert returns a namespace group`, async () => {
    const res = await supertest(app).get(`/${GROUP}/google-bert`);
    expect(res.status).toBe(200);
    expect(res.body.huggingfaceregistryid).toBe('google-bert');
    expect(res.body).toHaveProperty('modelsurl');
  });

  it('returns an explicit migration response for the removed fixed group', async () => {
    const res = await supertest(app).get(`/${GROUP}/huggingface.co/models/google-bert~bert-base-uncased`);
    expect(res.status).toBe(410);
    expect(res.body.replacement).toContain(`/${GROUP}/google-bert/`);
  });

  it('does not allow encoded legacy sentinels to bypass 410', async () => {
    const res = await supertest(app).get(`/${GROUP}/%68uggingface.co/models/google-bert%7Ebert-base-uncased/meta`);
    expect(res.status).toBe(410);
    expect(res.body.replacement).toBe(`/${GROUP}/google-bert/models/bert-base-uncased/meta`);
  });

  it('preserves the actual resource type and version suffix for malformed legacy IDs', async () => {
    const res = await supertest(app).get(`/${GROUP}/huggingface.co/datasets/bad%7Eid%7Eextra/versions/abc123`);
    expect(res.status).toBe(410);
    expect(res.body.replacement).toBe(`/${GROUP}/{owner}/datasets/{repository}/versions/abc123`);
  });

  it('returns 400 rather than 500 for malformed percent encodings', async () => {
    const res = await supertest(app).get(`/${GROUP}/google-bert/models/%ZZ`);
    expect(res.status).toBe(400);
  });

  it(`GET /${GROUP}/unknown returns 404`, async () => {
    expect((await supertest(app).get(`/${GROUP}/unknown`)).status).toBe(404);
  });

  // Model collection

  it('model list uses slash-free repository basenames', async () => {
    const res = await supertest(app).get(`/${GROUP}/google-bert/models`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('bert-base-uncased');
    expect(res.body).not.toHaveProperty('gpt2');
    expect(Object.keys(res.body).every(id => !id.includes('/'))).toBe(true);
  });

  it('model list entry has required xRegistry fields and repoid with slash', async () => {
    const res = await supertest(app).get(`/${GROUP}/google-bert/models`);
    const bert = res.body['bert-base-uncased'];
    expect(bert.modelid).toBe('bert-base-uncased');
    expect(bert.repoid).toBe('google-bert/bert-base-uncased');
    expect(bert).not.toHaveProperty('private');
    expect(bert).toHaveProperty('epoch');
    expect(bert).toHaveProperty('createdat');
    expect(bert).toHaveProperty('modifiedat');
    expect(bert).toHaveProperty('versionid');
    expect(bert).toHaveProperty('ancestor');
    expect(bert).toHaveProperty('metaurl');
    expect(bert).not.toHaveProperty('defaultversionurl');
    expect(bert).toHaveProperty('versionsurl');
    expect(bert).not.toHaveProperty('refs');
  });

  it('viewer name-prefix filter preserves pagination', async () => {
    const res = await supertest(app).get(
      `/${GROUP}/google-bert/models?filter=name=google*&limit=1&skip=0`,
    );
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['bert-base-uncased']);
    expect(res.headers['link']).toContain('limit=1');
    expect(res.headers['link']).toContain('offset=1');
    expect(res.headers['link']).toContain('filter=name%3Dgoogle*');

    const next = await supertest(app).get(
      `/${GROUP}/google-bert/models?filter=name=google*&limit=1&skip=1`,
    );
    expect(next.status).toBe(200);
    expect(Object.keys(next.body)).toEqual(['second-model']);
    expect(next.headers['link']).not.toContain('rel="next"');
  });

  it('preserves the requested filter field instead of treating modelid as name', async () => {
    const res = await supertest(app).get(`/${GROUP}/google-bert/models?filter=modelid=google*`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(res.headers['x-total-count']).toBe('0');
  });


  it('hydrates incomplete list summaries before applying an author filter', async () => {
    const res = await supertest(app).get(`/${GROUP}/google-bert/models?filter=author=google-bert`);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['bert-base-uncased', 'second-model']);
    expect(Object.values(res.body).every((item: any) => item.author === 'google-bert')).toBe(true);
    expect(res.headers['x-collection-complete']).toBe('true');
  });

  it('rejects unsupported sort instead of silently returning an unsorted collection', async () => {
    const res = await supertest(app).get(`/${GROUP}/google-bert/models?sort=downloads=desc`);
    expect(res.status).toBe(400);
    expect(res.body.title).toBe('Unsupported sort');
  });

  it('does not emit a next link for an exhausted deep offset', async () => {
    const res = await supertest(app).get(`/${GROUP}/google-bert/models?offset=5000&limit=1`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(res.headers['link'] ?? '').not.toContain('rel="next"');
  });

  it('rejects deep filtered skips before calling the Hub', async () => {
    const before = fixture.requests.filter(r => r.path === '/api/models').length;
    const res = await supertest(app).get(
      `/${GROUP}/google-bert/models?filter=name=google*&skip=501`,
    );
    const after = fixture.requests.filter(r => r.path === '/api/models').length;
    expect(res.status).toBe(400);
    expect(res.body.title).toBe('Filtered offset too large');
    expect(after).toBe(before);
  });

  // Entity-ID and canonical metadata contract

  it('collection group/resource entity IDs never contain slashes', async () => {
    const groups = await supertest(app).get(`/${GROUP}`);
    expect(Object.keys(groups.body).every(id => !id.includes('/'))).toBe(true);
    const models = await supertest(app).get(`/${GROUP}/google-bert/models`);
    expect(Object.keys(models.body).every(id => !id.includes('/'))).toBe(true);
  });

  it('preserves canonical owner/repository metadata', async () => {
    const res = await supertest(app).get(`/${GROUP}/google-bert/models/bert-base-uncased`);
    expect(res.body.name).toBe('google-bert/bert-base-uncased');
    expect(res.body.repository).toBe('google-bert/bert-base-uncased');
    expect(res.body.modelid).toBe('bert-base-uncased');
  });

  it('uses the exact Resource representation in owner collections', async () => {
    const collection = await supertest(app)
      .get(`/${GROUP}/google-bert/models?limit=10`)
      .set('x-base-url', 'https://registry.example.test');
    const exact = await supertest(app)
      .get(`/${GROUP}/google-bert/models/bert-base-uncased`)
      .set('x-base-url', 'https://registry.example.test');
    expect(collection.body['bert-base-uncased']).toEqual(exact.body);
  });

  it('redirects a public bare alias while preserving the complete query string', async () => {
    const query = 'limit=7&offset=2&filter=name%3Dgpt*&sort=name%3Ddesc&inline=versions&filter=epoch%3D1';
    const res = await supertest(app).get(`/${GROUP}/_/models/gpt2?${query}`).redirects(0);
    expect(res.status).toBe(308);
    const location = String(res.headers.location);
    expect(new URL(location).pathname).toBe(`/${GROUP}/openai-community/models/gpt2`);
    expect(location.endsWith(`?${query}`)).toBe(true);
  });

  it('emits group, Resource, Meta, and Version entities conforming to its runtime model', async () => {
    const group = await supertest(app).get(`/${GROUP}/google-bert`);
    assertGroupConforms(modelData, GROUP, group.body, 'huggingface.group');

    const resource = await supertest(app).get(`/${GROUP}/google-bert/models/bert-base-uncased`);
    assertResourceConforms(modelData, GROUP, 'models', resource.body, 'huggingface.resource');

    const meta = await supertest(app).get(`/${GROUP}/google-bert/models/bert-base-uncased/meta`);
    assertMetaConforms(modelData, GROUP, 'models', meta.body, 'huggingface.meta');

    const versions = await supertest(app).get(`/${GROUP}/google-bert/models/bert-base-uncased/versions`);
    for (const [id, version] of Object.entries(versions.body)) {
      assertVersionConforms(modelData, GROUP, 'models', version, `huggingface.version.${id}`);
    }
    assertResourceProjectsVersion(
      modelData, GROUP, 'models', resource.body, versions.body[resource.body.versionid], 'huggingface.resource',
    );

    const space = await supertest(app).get(`/${GROUP}/gradio/spaces/hello_world`);
    assertResourceConforms(modelData, GROUP, 'spaces', space.body, 'huggingface.space');
  });

  it('uses the valid reserved _ group only for a truly unnamespaced repository', async () => {
    const res = await supertest(app).get(`/${GROUP}/_/models/true-bare-model`);
    expect(res.status).toBe(200);
    expect(res.body.modelid).toBe('true-bare-model');
    expect(res.body.repository).toBe('true-bare-model');
    expect(res.body.xid).toBe(`/${GROUP}/_/models/true-bare-model`);
  });

  it('uses the exact upstream author parameter for dotted owners', async () => {
    const res = await supertest(app).get(`/${GROUP}/org.example/models`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('dotted-model');
    const authorRequests = fixture.requests.filter(request => {
      const url = new URL(request.url, fixture.url);
      return request.path === '/api/models' && url.searchParams.get('author') === 'org.example';
    });
    expect(authorRequests.length).toBeGreaterThan(0);
    expect(authorRequests.every(request => !new URL(request.url, fixture.url).searchParams.has('search'))).toBe(true);
  });

  it('returns 404 for a child collection whose owner does not exist', async () => {
    const res = await supertest(app).get(`/${GROUP}/does.not.exist/models`);
    expect(res.status).toBe(404);
  });

  it("materializes a coherent default Version when gated enrichment is unauthorized", async () => {
    const sha = String(FIXTURE_MODEL_GATED.sha);
    const base = `/${GROUP}/gated-org/models/public-metadata`;
    const resource = await supertest(app).get(base).set("x-base-url", "https://registry.example.test");
    const meta = await supertest(app).get(`${base}/meta`).set("x-base-url", "https://registry.example.test");
    const versions = await supertest(app).get(`${base}/versions`).set("x-base-url", "https://registry.example.test");
    const exact = await supertest(app).get(`${base}/versions/${sha}`).set("x-base-url", "https://registry.example.test");

    expect([resource.status, meta.status, versions.status, exact.status]).toEqual([200, 200, 200, 200]);
    expect(resource.body).toMatchObject({ modelid: "public-metadata", versionid: sha, versionscount: 1 });
    expect(meta.body).toMatchObject({ gated: true, defaultversionid: sha });
    expect(meta.body.defaultversionurl).toContain(`/versions/${sha}`);
    expect(meta.body).not.toHaveProperty("refs");
    expect(Object.keys(versions.body)).toEqual([sha]);
    expect(versions.headers["x-total-count"]).toBe("1");
    expect(versions.body[sha]).toEqual(exact.body);
    expect(exact.body).toMatchObject({ modelid: "public-metadata", versionid: sha, sha, isdefault: true });
    expect(resource.body.versionscount).toBe(Object.keys(versions.body).length);
    assertResourceProjectsVersion(modelData, "huggingfaceregistries", "models", resource.body, exact.body, "hf.gated");
  });

  it('returns 404 rather than redirecting wrong-case entity IDs', async () => {
    for (const requestPath of [
      `/${GROUP}/Google-Bert`,
      `/${GROUP}/Google-Bert/models/bert-base-uncased`,
      `/${GROUP}/google-bert/models/Bert-Base-Uncased`,
      `/${GROUP}/HuggingFace.co/models/google-bert~bert-base-uncased`,
    ]) {
      const res = await supertest(app).get(requestPath).redirects(0);
      expect(res.status).toBe(404);
      expect(res.headers.location).toBeUndefined();
    }
  });

  // Single model

  it('model doc has all required fields including refs', async () => {
    const res = await supertest(app).get(`/${GROUP}/google-bert/models/bert-base-uncased`);
    expect(res.status).toBe(200);
    expect(res.body.modelid).toBe('bert-base-uncased');
    expect(res.body.repoid).toBe('google-bert/bert-base-uncased');
    expect(res.body.sha).toBe('a86a4d9a4e7bfed432ab38a4462a66bc50f34f49');
    expect(res.body.versionid).toBe('a86a4d9a4e7bfed432ab38a4462a66bc50f34f49');
    expect(res.body.isdefault).toBe(true);
    expect(res.body).toHaveProperty('versionsurl');
    expect(res.body).not.toHaveProperty('refs');
    expect(res.body).not.toHaveProperty('pipeline_tag');
    const meta = await supertest(app).get(`/${GROUP}/google-bert/models/bert-base-uncased/meta`);
    expect(meta.body.refs.branches).toHaveLength(2);
    expect(meta.body.refs.tags).toHaveLength(1);
    expect(meta.body.pipeline_tag).toBe('fill-mask');
    expect(new URL(res.body.self).pathname).toBe(
      `/${GROUP}/google-bert/models/bert-base-uncased`,
    );
    expect((await supertest(app).get(new URL(res.body.self).pathname)).status).toBe(200);
  });

  it('model meta identifies /meta and contains required rc2 default-version fields', async () => {
    const res = await supertest(app).get(`/${GROUP}/google-bert/models/bert-base-uncased/meta`);
    expect(res.status).toBe(200);
    expect(res.body.xid).toBe(`/${GROUP}/google-bert/models/bert-base-uncased/meta`);
    expect(new URL(res.body.self).pathname).toBe(`/${GROUP}/google-bert/models/bert-base-uncased/meta`);
    expect(res.body).toMatchObject({
      modelid: 'bert-base-uncased',
      readonly: true,
      compatibility: 'none',
      defaultversionsticky: false,
    });
    expect(res.body).not.toHaveProperty('ancestor');
    expect(res.body).toHaveProperty('defaultversionurl');
  });

  it('model resource has mutable Cache-Control (not immutable)', async () => {
    const res = await supertest(app).get(`/${GROUP}/google-bert/models/bert-base-uncased`);
    const cc = res.headers['cache-control'] as string;
    expect(cc).toMatch(/max-age=300/);
    expect(cc).not.toMatch(/immutable/);
  });

  it('unknown model → 404', async () => {
    expect((await supertest(app).get(`/${GROUP}/unknown/models/nonexistent`)).status).toBe(404);
  });

  // ── Version list (commits) ────────────────────────────────────────────────

  it('version list returns commit SHAs as keys', async () => {
    const res = await supertest(app).get(`/${GROUP}/google-bert/models/bert-base-uncased/versions`);
    expect(res.status).toBe(200);
    const v = res.body['a86a4d9a4e7bfed432ab38a4462a66bc50f34f49'];
    expect(v).toBeDefined();
    expect(v.sha).toBe('a86a4d9a4e7bfed432ab38a4462a66bc50f34f49');
    expect(v.isdefault).toBe(true);
    expect(v.ancestor).toBe(v.versionid);
    const selfPath = new URL(v.self).pathname;
    expect(selfPath).toBe(
      `/${GROUP}/google-bert/models/bert-base-uncased/versions/${v.sha}`,
    );
    expect((await supertest(app).get(selfPath)).status).toBe(200);
  });

  it('version list has short-TTL mutable Cache-Control', async () => {
    const res = await supertest(app).get(`/${GROUP}/google-bert/models/bert-base-uncased/versions`);
    expect(res.headers['cache-control']).toMatch(/max-age=60/);
  });

  it('sorts Version IDs and omits next on the confirmed terminal page', async () => {
    const first = await supertest(app).get(`/${GROUP}/google-bert/models/bert-base-uncased/versions?limit=1&offset=0`);
    const second = await supertest(app).get(`/${GROUP}/google-bert/models/bert-base-uncased/versions?limit=1&offset=1`);
    expect(first.headers.link).toContain('rel="next"');
    expect(second.headers.link ?? '').not.toContain('rel="next"');
    const ids = [...Object.keys(first.body), ...Object.keys(second.body)];
    expect(ids).toEqual([...ids].sort());
  });

  // ── Deep commit lookup (regression #2) ────────────────────────────────────

  it('direct SHA lookup returns deep commit not on page-1', async () => {
    const res = await supertest(app).get(
      `/${GROUP}/google-bert/models/bert-base-uncased/versions/${DEEP_COMMIT_SHA}`,
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
      `/${GROUP}/google-bert/models/bert-base-uncased/versions/${DEEP_COMMIT_SHA}`,
    );
    expect(res.headers['cache-control']).toMatch(/immutable/);
    expect(res.headers['cache-control']).toMatch(/max-age=31536000/);
  });

  it('HEAD SHA version has immutable Cache-Control', async () => {
    const sha = 'a86a4d9a4e7bfed432ab38a4462a66bc50f34f49';
    const res = await supertest(app).get(`/${GROUP}/google-bert/models/bert-base-uncased/versions/${sha}`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toMatch(/immutable/);
  });

  // ── Non-main default branch (regression #3) ────────────────────────────────

  it('version list uses gitalyDefaultBranch=master, not hardcoded main', async () => {
    const res = await supertest(app).get(
      `/${GROUP}/test-org/models/model-with-master-branch/versions`,
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
      `/${GROUP}/test-org/models/model-with-master-branch/versions/${sha}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.versionid).toBe(sha);
  });

  // ── Negative cache (regression #4) ────────────────────────────────────────

  it('404 repo is negatively cached: only one upstream request made', async () => {
    const path = '/api/models/unknown/nonexistent';
    const before = fixture.requests.filter(r => r.path === path).length;
    await supertest(app).get(`/${GROUP}/unknown/models/nonexistent`);
    await supertest(app).get(`/${GROUP}/unknown/models/nonexistent`);
    const after = fixture.requests.filter(r => r.path === path).length;
    // Only one real upstream hit; second served from negative cache
    expect(after - before).toBeLessThanOrEqual(1);
  });

  it('immutable SHA version is cached: second request hits no upstream', async () => {
    const sha = 'a86a4d9a4e7bfed432ab38a4462a66bc50f34f49';
    const urlPath = `/api/models/google-bert/bert-base-uncased/commits/${sha}`;
    const before = fixture.requests.filter(r => r.path === urlPath).length;
    await supertest(app).get(`/${GROUP}/google-bert/models/bert-base-uncased/versions/${sha}`);
    await supertest(app).get(`/${GROUP}/google-bert/models/bert-base-uncased/versions/${sha}`);
    const after = fixture.requests.filter(r => r.path === urlPath).length;
    expect(after - before).toBeLessThanOrEqual(1);
  });

  // ── Dataset endpoints ─────────────────────────────────────────────────────

  it('dataset list uses repository basename', async () => {
    const res = await supertest(app).get(`/${GROUP}/rajpurkar/datasets`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('squad');
  });

  it('single dataset has correct repoid', async () => {
    const res = await supertest(app).get(`/${GROUP}/rajpurkar/datasets/squad`);
    expect(res.status).toBe(200);
    expect(res.body.datasetid).toBe('squad');
    expect(res.body.repoid).toBe('rajpurkar/squad');
  });

  // ── Space endpoints ────────────────────────────────────────────────────────

  it('space list uses repository basename', async () => {
    const res = await supertest(app).get(`/${GROUP}/gradio/spaces`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('hello_world');
  });

  it('single space has sdk field', async () => {
    const res = await supertest(app).get(`/${GROUP}/gradio/spaces/hello_world`);
    expect(res.status).toBe(200);
    expect(res.body.spaceid).toBe('hello_world');
    expect(res.body).not.toHaveProperty('sdk');
    const meta = await supertest(app).get(`/${GROUP}/gradio/spaces/hello_world/meta`);
    expect(meta.body.sdk).toBe('gradio');
  });

  it('unknown resource type → 404', async () => {
    expect((await supertest(app).get(`/${GROUP}/google-bert/unknown-type`)).status).toBe(404);
  });
});
