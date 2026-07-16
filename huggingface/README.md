# Hugging Face Hub xRegistry Proxy

An xRegistry 1.0-rc2 compliant proxy for the public [Hugging Face Hub](https://huggingface.co/) API, exposing models, datasets, and spaces as xRegistry resources.

## Security model (V1)

**Anonymous-only.** This proxy:

- **Never accepts** bearer tokens or any `Authorization` header from callers – requests with credentials are rejected with `400 Bad Request`.
- **Never configures or forwards** any HF token to the upstream API.
- Calls the HF Hub API **without any authentication**, returning only what is publicly visible.
- For gated or private resources, the response reflects their **publicly visible status** (`gated: "auto"`, `private: true`) but never attempts a gated download.

## xRegistry structure

| Layer | Value |
|---|---|
| Group type (plural) | `huggingfaceregistries` |
| Group type (singular) | `huggingfaceregistry` |
| Group ID | `huggingface.co` |
| Resource types | `models`, `datasets`, `spaces` |
| Version IDs | **Commit SHAs** (immutable) |
| Mutable aliases | **Branches and tags** embedded in the `refs` attribute of each resource |

### Repo ID encoding

HF repo IDs are `{owner}/{name}` (e.g. `google/bert-base-uncased`). Since `/` is a URL path separator, the proxy maps `/` → `~` for URL segments:

```
google/bert-base-uncased  →  google~bert-base-uncased
gpt2                      →  gpt2          (unchanged)
```

The original repo ID is always preserved in the `repoid` attribute.

### Cache policy

| Content | TTL | `Cache-Control` |
|---|---|---|
| Resource lists, group docs, registry root | 5 min | `public, max-age=300, s-maxage=300` |
| Individual resources (model/dataset/space) | 5 min | `public, max-age=300, s-maxage=300` |
| Version lists (commit lists) | 1 min | `public, max-age=60` |
| Individual versions (commit SHAs) | **Immutable** | `public, max-age=31536000, immutable` |

Commit SHAs are content-addressed and never change, so they receive a 1-year immutable cache header. Branch/tag aliases live in the resource document and inherit the 5-minute TTL.

## Endpoints

```
GET /                                                          Registry root
GET /health                                                    Health check
GET /ready                                                     Readiness check
GET /model                                                     xRegistry model
GET /capabilities                                              Capabilities

GET /huggingfaceregistries                                     Group collection
GET /huggingfaceregistries/huggingface.co                      Group document

GET /huggingfaceregistries/huggingface.co/models               Model list
GET /huggingfaceregistries/huggingface.co/models/:id           Model resource
GET /huggingfaceregistries/huggingface.co/models/:id/meta      Model meta
GET /huggingfaceregistries/huggingface.co/models/:id/versions  Version list
GET /huggingfaceregistries/huggingface.co/models/:id/versions/:sha  Version

GET /huggingfaceregistries/huggingface.co/datasets/...         (same structure)
GET /huggingfaceregistries/huggingface.co/spaces/...           (same structure)
```

All list endpoints support `?limit` and `?skip` (models/datasets/spaces) or `?page` (versions).

## Configuration

| Variable | Default | Description |
|---|---|---|
| `PORT` | `4300` | Listen port |
| `HOST` | `0.0.0.0` | Listen host |
| `HF_API_URL` | `https://huggingface.co` | HF Hub base URL |
| `UPSTREAM_TIMEOUT_MS` | `10000` | Per-attempt HTTP timeout |
| `UPSTREAM_OPERATION_TIMEOUT_MS` | `30000` | Total operation timeout |
| `UPSTREAM_MAX_ATTEMPTS` | `3` | HTTP retry count |
| `UPSTREAM_CONCURRENCY` | `16` | Max concurrent upstream requests |
| `CACHE_DIR` | `./cache` | Disk cache directory |
| `MUTABLE_CACHE_TTL_MS` | `300000` | TTL for mutable content (5 min) |
| `IMMUTABLE_CACHE_TTL_MS` | `31536000000` | TTL for immutable commits (1 year) |

**Note:** No `HF_TOKEN` or credential environment variable is accepted.

## Running locally

```bash
cd huggingface
npm ci
npm run build
npm start
```

Open `http://localhost:4300/huggingfaceregistries/huggingface.co/models?limit=5`.

## Running with Docker

```bash
# From repo root
docker build -f huggingface.Dockerfile -t xregistry-hf .
docker run -p 4300:4300 xregistry-hf
```

## Running tests

```bash
# Unit tests (no network required)
cd huggingface && npm test

# Integration tests (requires running server or Docker)
cd test && npm run test:huggingface
```

## Design notes

### Why branches/tags are not modelled as versions

xRegistry versions are meant to be stable, addressable snapshots. Branches and tags are **mutable pointers** to commits that change over time. Including them in the versions collection would violate the immutability expectation for versioned resources. Instead they are embedded as the `refs` attribute (short cache TTL) on the resource document, allowing callers to discover the commit SHA a branch or tag resolves to and then request the immutable version directly.

### Count fields

`versionscount` is **omitted** from resource documents because the HF Hub API does not expose an authoritative total commit count. Displaying an inaccurate count would be misleading. Per the xRegistry spec, counts should only be present when they are authoritative.
