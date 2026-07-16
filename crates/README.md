# xregistry-crates-wrapper

xRegistry-compliant proxy for [crates.io](https://crates.io) — the Rust package registry.

## Overview

This service maps the crates.io API to the [xRegistry](https://xregistry.io/) 1.0-rc2 specification. It exposes Rust crates as xRegistry resources in the `rustregistries` group type.

## Model

- **Group type**: `rustregistries`
- **Registry**: `crates.io`
- **Resource type**: `crates`
- **Port**: `3700`

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Registry root |
| `GET` | `/health` | Health check |
| `GET` | `/ready` | Readiness check |
| `GET` | `/model` | xRegistry model definition |
| `GET` | `/capabilities` | Registry capabilities |
| `GET` | `/rustregistries` | List of rust registries |
| `GET` | `/rustregistries/crates.io` | The crates.io registry group |
| `GET` | `/rustregistries/crates.io/crates` | Paginated list of crates |
| `GET` | `/rustregistries/crates.io/crates/:crateId` | Single crate |
| `GET` | `/rustregistries/crates.io/crates/:crateId/versions` | All versions for a crate |
| `GET` | `/rustregistries/crates.io/crates/:crateId/versions/:versionId` | Single version (immutable) |

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `HOST` | `0.0.0.0` | Listen host |
| `PORT` | `3700` | Listen port |
| `UPSTREAM_URL` | `https://crates.io` | crates.io API base URL |
| `UPSTREAM_TIMEOUT_MS` | `10000` | Per-attempt timeout (ms) |
| `UPSTREAM_OPERATION_TIMEOUT_MS` | `30000` | Total operation timeout (ms) |
| `UPSTREAM_MAX_ATTEMPTS` | `3` | Retry attempts |
| `UPSTREAM_CONCURRENCY` | `16` | Max concurrent upstream requests |
| `CACHE_TTL_MS` | `300000` | Positive cache TTL (5 min) |
| `CACHE_NEGATIVE_TTL_MS` | `30000` | Negative (404) cache TTL (30 s) |
| `CACHE_STALE_IF_ERROR_MS` | `900000` | Stale-while-revalidate on error (15 min) |
| `FIXTURE_MODE` | `false` | Use local fixtures instead of upstream |
| `CACHE_DIR` | `./cache` | Filesystem cache directory |

## Cache and Rate Limits

- **Positive entries** are cached for `CACHE_TTL_MS` (default 5 minutes).
- **Negative entries** (404) are cached for `CACHE_NEGATIVE_TTL_MS` (default 30 seconds).
- **Stale-while-revalidate**: When upstream returns an error, cached data is served for up to `CACHE_STALE_IF_ERROR_MS` (default 15 minutes) beyond the TTL.
- **Conditional validators**: `ETag` and `Last-Modified` headers from crates.io are preserved and forwarded on subsequent requests.
- **Rate limits**: HTTP 429 responses from crates.io are propagated with `Retry-After` headers.

## Version Semantics

All version resources have `immutable: true` — once published, a crate version is immutable. `isdefault: true` is set on the `max_stable_version`.

Yanked versions (`yanked: true`) are included in version lists but marked accordingly.

## Fixture Mode

Set `FIXTURE_MODE=true` to run the proxy against built-in fixture data (useful for CI, testing, and offline development). Fixtures include `serde` and `tokio`.

```sh
FIXTURE_MODE=true npm start
```

## Development

```sh
# Build
npm run build

# Start in fixture mode
FIXTURE_MODE=true npm start

# Test (builds test files then runs them)
npm run test:run
```

## Production Evidence

```sh
# Health check
curl http://localhost:3700/health
# → {"status":"ok"}

# Model
curl http://localhost:3700/model | jq '.groups.rustregistries'

# List crates (first page)
curl 'http://localhost:3700/rustregistries/crates.io/crates?limit=10'

# Get serde crate
curl http://localhost:3700/rustregistries/crates.io/crates/serde | jq '{name,max_version,downloads}'

# Get serde version
curl http://localhost:3700/rustregistries/crates.io/crates/serde/versions/1.0.219 | jq '{versionid,immutable,license}'
```

## Docker

```sh
# Build
docker build -f crates.Dockerfile -t xregistry-crates-bridge .

# Run (live mode)
docker run -p 3700:3700 -e UPSTREAM_URL=https://crates.io xregistry-crates-bridge

# Run (fixture mode)
docker run -p 3700:3700 -e FIXTURE_MODE=true xregistry-crates-bridge
```
