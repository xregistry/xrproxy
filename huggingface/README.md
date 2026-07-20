# Hugging Face Hub xRegistry Proxy

Anonymous, read-only [xRegistry 1.0-rc2](https://github.com/xregistry/spec/blob/main/core/spec.md) access to public Hugging Face models, datasets, and spaces.

## Native identity mapping

Owners/namespaces are xRegistry groups. Repository basenames are resources independently within `models`, `datasets`, and `spaces`:

| Hugging Face ID | Group | Resource | xRegistry path |
|---|---|---|---|
| `google-bert/bert-base-uncased` | `google-bert` | `bert-base-uncased` | `/huggingfaceregistries/google-bert/models/bert-base-uncased` |
| `rajpurkar/squad` | `rajpurkar` | `squad` | `/huggingfaceregistries/rajpurkar/datasets/squad` |
| `gradio/hello_world` | `gradio` | `hello_world` | `/huggingfaceregistries/gradio/spaces/hello_world` |
| alias `gpt2` | `openai-community` | `gpt2` | `/huggingfaceregistries/openai-community/models/gpt2` |
| true bare ID `<repo>` | `_` | `<repo>` | `/huggingfaceregistries/_/models/<repo>` |

`_` is a valid xRegistry Entity ID and is reserved only for an upstream `repoInfo.id` that is truly bare. Public aliases such as `gpt2` are not duplicated there: exact lookup derives identity from authoritative `repoInfo.id` and returns HTTP 308 to the canonical owner path. A request that differs only by entity-ID casing returns 404 rather than being treated as an alias. Group/resource IDs never contain `/`; canonical upstream identity is retained in `name`, `repository`, and `repoid`. Exact repository and commit-SHA lookup calls the Hub directly and does not depend on discovery. See xRegistry Core, [`<SINGULAR>id` constraints](https://github.com/xregistry/spec/blob/v1.0-rc2/core/spec.md#singularid-id-attribute).

## Endpoints

```text
GET /
GET /model
GET /modelsource
GET /capabilities
GET /health
GET /ready
GET /huggingfaceregistries
GET /huggingfaceregistries/{owner}
GET /huggingfaceregistries/{owner}/{models|datasets|spaces}
GET /huggingfaceregistries/{owner}/{type}/{repository}
GET /huggingfaceregistries/{owner}/{type}/{repository}/meta
GET /huggingfaceregistries/{owner}/{type}/{repository}/versions
GET /huggingfaceregistries/{owner}/{type}/{repository}/versions/{sha}
```

Group and resource collections accept `limit` and `offset` (`skip` remains an input alias). Filters retain the requested field (for example, `modelid=...` is not rewritten to `name=...`). List summaries can omit `author` and `sha`, so those filters hydrate at most 50 exact repositories before evaluation; offsets beyond that detail-filter budget receive HTTP 400. Other discovery scans remain capped at 1,000 items. `sort` is not advertised and receives HTTP 400.

`GET /capabilities` returns the complete xRegistry 1.0-rc2 capability map. This read-only proxy advertises only the `filter` flag, `manual` version mode, pagination, and `xRegistry-json/1.0-rc2`; unsupported `inline` is omitted (Core, **Registry Capabilities**).

Responses include a `next` link only when the scanned snapshot contains a real sentinel item. An exhausted bounded snapshot never manufactures an infinite continuation: it emits `X-Collection-Complete: false`, omits an unknown total, and has no `next`. `X-Total-Count` and `{plural}count` appear only after an authoritative end-of-scan (xRegistry Core, **Collection Serialization** and **Filter Flag**; Pagination, **next Link**).

## Public path migration (#203)

```text
OLD /huggingfaceregistries/huggingface.co/models/google-bert~bert-base-uncased
NEW /huggingfaceregistries/google-bert/models/bert-base-uncased
```

All paths below the removed fixed `huggingface.co` group return **HTTP 410 Gone** with a replacement hint using the actual resource type and retaining `/meta`, `/versions`, or Version suffixes. There is no redirect or fallback to slash-bearing identities.

## Versions and caching

Resource default versions and version IDs are immutable commit SHAs. Resource and Version lineage is emitted through the rc2 `ancestor` attribute. Branches/tags remain mutable pointers in the Resource Meta `refs` attribute. The model uses xRegistry's built-in Resource Version mechanism (`maxversions: 0`, `versionmode: manual`). The current upstream HEAD is a non-sticky default (`defaultversionsticky: false`).

If anonymous refs or commit enrichment returns HTTP 401/403 while repository metadata still exposes a SHA, that SHA is materialized as a minimal Version. Resource, Meta, Versions collection, and exact Version reads therefore retain one resolvable default.

| Content | Cache policy |
|---|---|
| Discovery and resources | 5 minutes |
| Commit lists | 1 minute |
| Commit SHA | `max-age=31536000, immutable` |

## Security

The proxy never configures or forwards a Hub token. Incoming `Authorization` headers are rejected with HTTP 400, so only anonymously visible data is exposed.

## Configuration and validation

| Variable | Default |
|---|---|
| `PORT` | `4300` |
| `HOST` | `0.0.0.0` |
| `HF_API_URL` | `https://huggingface.co` |
| `CACHE_DIR` | `./cache` |
| `MUTABLE_CACHE_TTL_MS` | `300000` |
| `IMMUTABLE_CACHE_TTL_MS` | `31536000000` |

```bash
cd huggingface
npm ci
npm run build
npm test
```
