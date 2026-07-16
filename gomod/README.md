# xRegistry Go Module Proxy

An [xRegistry 1.0-rc2](https://github.com/xregistry/spec) compliant proxy for the Go module ecosystem.

## Overview

| Attribute       | Value                         |
|-----------------|-------------------------------|
| Group type      | `goregistries`                |
| Group ID        | `pkg.go.dev`                  |
| Resource type   | `modules`                     |
| Default port    | `3900`                        |
| Upstream proxy  | `https://proxy.golang.org`    |
| Discovery index | `https://index.golang.org`    |

## Key design decisions

### Exact lookup — GOPROXY protocol

Module and version metadata is fetched on-demand from `proxy.golang.org` using the [GOPROXY protocol](https://go.dev/ref/mod#goproxy-protocol):

- `/{module}/@v/{version}.info` → version timestamp and canonical version string
- `/{module}/@v/{version}.mod` → go.mod contents
- `/{module}/@v/{version}.zip` → module zip
- `/{module}/@latest` → latest known version

### Discovery — append-only Go index with resumable checkpoints

Module discovery uses the [Go module index](https://index.golang.org/index), which is an append-only log. A local catalog (`cache/catalog.json`) is maintained with:

- A `since` cursor (RFC 3339 timestamp) pointing to the next page to fetch.
- Per-module version lists and latest-version tracking.
- Background refresh every 6 hours (configurable via `INDEX_REFRESH_MS`).

The catalog file is a plain JSON file — **no cloud-provider-specific code** — making it suitable for bundling as a signed OCI artifact.

#### Index cursor semantics and catalog limitations

The index cursor advances as follows:

- When a page returns **fewer entries than the page limit** (i.e. we have reached the current end of the index), the cursor advances to the timestamp of the last entry and the refresh stops.
- When a page is **exactly full**, the cursor stays at the same timestamp on the next call. This guarantees overlap: the next page will re-deliver entries sharing that boundary timestamp. The `CheckpointService` deduplicates by `path@version` using an in-memory `seen` set that is rebuilt from the persisted catalog on startup, so overlapping entries are idempotent and never inflate counts.

**Consequence:** the catalog may be a partial snapshot at any given time — especially right after startup before the first background refresh completes. The `modulescount` field in API responses is omitted (not returned as `null`) when the catalog is empty, preventing consumers from treating a freshly-started instance as authoritative about the total universe of Go modules.

**Exact-lookup mitigates this:** any module path and version known to `proxy.golang.org` can be looked up immediately regardless of catalog coverage. The catalog exists only to support discovery (listing/filtering modules); it does not gate exact metadata retrieval.

### Path escaping

Per the [Go module proxy spec](https://pkg.go.dev/golang.org/x/mod/module#EscapePath), uppercase ASCII letters in module paths are escaped: `A` → `!a`. For example:

```
github.com/BurntSushi/toml  →  github.com/!burnt!sushi/toml
```

The proxy handles both escaped and canonical forms in xRegistry URLs.

### Immutable versions

Module versions are immutable (Go's semantic import versioning guarantees this). Pseudo-versions (`v0.0.0-20210101000000-abcdef012345`) are detected and their embedded timestamps are preserved in xRegistry version records.

## API endpoints

| Method | Path                                                             | Description                   |
|--------|------------------------------------------------------------------|-------------------------------|
| GET    | `/`                                                              | xRegistry root                |
| GET    | `/model`                                                         | xRegistry model               |
| GET    | `/capabilities`                                                  | Capabilities                  |
| GET    | `/goregistries`                                                  | Registry group collection     |
| GET    | `/goregistries/pkg.go.dev`                                       | Registry group detail         |
| GET    | `/goregistries/pkg.go.dev/modules`                               | Module collection (paginated) |
| GET    | `/goregistries/pkg.go.dev/modules/:modulePath`                   | Module detail                 |
| GET    | `/goregistries/pkg.go.dev/modules/:modulePath/versions`          | Version collection            |
| GET    | `/goregistries/pkg.go.dev/modules/:modulePath/versions/:version` | Version detail                |
| GET    | `/health`                                                        | Health check                  |

### Pagination

Collections support `?limit=N&offset=M`. The `Link: <url>; rel="next"` header and `X-Total-Count` response header are set when applicable.

### Filtering

The `?filter=name=github.com/gorilla/*` parameter supports substring and glob matching against module paths.

## Environment variables

| Variable                  | Default                           | Description                            |
|---------------------------|-----------------------------------|----------------------------------------|
| `PORT`                    | `3900`                            | Listen port                            |
| `HOST`                    | `0.0.0.0`                         | Listen host                            |
| `GOPROXY_URL`             | `https://proxy.golang.org`        | Override GOPROXY upstream              |
| `GO_INDEX_URL`            | `https://index.golang.org`        | Override Go module index URL           |
| `CACHE_DIR`               | `./cache`                         | Catalog/checkpoint persistence dir     |
| `XREGISTRY_GOMOD_API_KEY` | *(none)*                          | Optional API key (Bearer or header)    |
| `BASE_URL`                | *(derived from request)*          | Override self-reference base URL       |

## Running locally

```bash
cd gomod
npm install
npm run build
npm start
```

## Running with Docker

```bash
docker build -f gomod.Dockerfile -t xregistry-gomod .
docker run -p 3900:3900 xregistry-gomod
```

## Testing

```bash
cd gomod
npm install
npm test
```

## Catalog persistence

The file `cache/catalog.json` holds the accumulated module catalog. It is a plain JSON document (schema version 1) that can be:

- Checked into version control for reproducible bootstrapping.
- Bundled as a layer in a signed OCI artifact for distribution.
- Replaced at startup by mounting a pre-seeded catalog volume.

No Azure Blob Storage, AWS S3, or GCS SDK code is included.

## Integration with the bridge

Add the service to the bridge `DOWNSTREAMS_JSON`:

```json
{"url":"http://gomod:3900","apikey":"gomod-api-key"}
```

The bridge discovers the `goregistries` group type automatically.
