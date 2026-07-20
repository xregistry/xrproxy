# pub.dev xRegistry Proxy

An [xRegistry 1.0-rc2](https://xregistry.io/) compliant proxy for the [pub.dev](https://pub.dev/) Dart/Flutter package registry.

## Overview

This service exposes the pub.dev package registry as an xRegistry-compliant API, enabling uniform discovery and metadata access for Dart and Flutter packages alongside other supported registries (npm, PyPI, Maven, NuGet, OCI, MCP).

### Group type: `dartregistries`
### Registry ID: `pub.dev`
### Default port: `4200`

## API Endpoints

| Path | Description |
|------|-------------|
| `GET /` | xRegistry root with group counts |
| `GET /health` | Health check |
| `GET /model` | Registry model definition |
| `GET /modelsource` | Sparse registry model source |
| `GET /capabilities` | Server capabilities |
| `GET /dartregistries` | All Dart registry groups |
| `GET /dartregistries/pub.dev` | pub.dev group details |
| `GET /dartregistries/pub.dev/packages` | Package collection (paginated) |
| `GET /dartregistries/pub.dev/packages/{name}` | Package metadata |
| `GET /dartregistries/pub.dev/packages/{name}/meta` | Package meta (default version) |
| `GET /dartregistries/pub.dev/packages/{name}/versions` | All versions |
| `GET /dartregistries/pub.dev/packages/{name}/versions/{version}` | Specific version |

## Query Parameters

- `limit` — Maximum items per page (default: 50)
- `offset` — Page offset (default: 0)
- `filter` — Filter expression (e.g., `name=http`, `name=flutter*`)
- `sort` — Sort order (e.g., `name=asc`, `name=desc`)

`GET /capabilities` emits the complete xRegistry 1.0-rc2 capability map. Only implemented `filter` and `sort` flags are advertised; `inline` is not. The service is read-only (`mutable: []`) and reports pagination, `manual` version mode, and the required `xRegistry-json/1.0-rc2` schema (Core, **Registry Capabilities**).

## Version Semantics

The model uses xRegistry's built-in Resource Version mechanism (`maxversions: 0`, `setversionid: true`, `versionmode: manual`); Versions are not nested Resources. `manual` is required because reversible xRegistry IDs for versions containing build metadata are opaque and are not Semantic Versions.

The highest Version in the deterministic pub.dev semantic ordering selects the default Version. The model sets `setdefaultversionsticky: false`, and Resource metadata emits `defaultversionsticky: false`; adding a newer ordered Version advances the default. Ancestors form one deterministic chain in that same order; the first Version points to itself and each later Version points to its predecessor.

- The raw version is preserved exactly in `version` (for example `1.4.0`, `1.0.0-beta.1`, `2.0.0+1`)
- Prereleases (e.g., `-alpha`, `-beta`, `-rc`) are preserved with their full prerelease identifier
- A raw version that is already an xRegistry-safe Entity ID remains unchanged. Versions containing `+` (or the reserved encoding prefix) use reversible `xv~<base64url(raw-version)>` IDs, because `+` is not permitted by xRegistry Core [`<SINGULAR>id` constraints](https://github.com/xregistry/spec/blob/v1.0-rc2/core/spec.md#singularid-id-attribute)
- Versions are sorted oldest-first following pub.dev semver ordering
- The highest deterministically ordered version is marked `isdefault: true`

## Package Attributes

Each package response includes:
- `name`, `description`, `homepage`, `repository`
- `publisher` — verified publisher domain (e.g., `dart.dev`)
- `sdk_constraint` — Dart SDK constraint (e.g., `>=3.0.0 <4.0.0`)
- `flutter_constraint` — Flutter SDK constraint if applicable
- `dependencies`, `dev_dependencies` — with xid cross-references
- `likes`, `pub_points`, `popularity` — pub.dev scoring metrics
- `keywords` — from pubspec `topics`
- `platforms` — supported platforms

## Version Attributes

Each version response includes:
- `versionid` — xRegistry-safe ID; usually the semver string, reversibly encoded when needed
- `version` — exact raw pub.dev version
- `published` — ISO 8601 publish timestamp
- `archive_url` — download URL for the `.tar.gz` archive
- `archive_sha256` — SHA-256 checksum of the archive (when available)
- `pubspec` — raw pubspec.yaml as parsed JSON
- `sdk_constraint`, `flutter_constraint`
- `retracted` — whether the version has been retracted
- `isdefault` — `true` for the highest deterministically ordered version
- `ancestor` — previous encoded Version ID in sequence

Dependency XID model targets use the plural Resource collection path `/dartregistries/packages`, as required by the rc2 model target grammar.

## Running Locally

```bash
cd pubdev
npm install
npm run build
npm start
```

The server starts on port `4200` by default.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `4200` | Listening port |
| `HOST` | `0.0.0.0` | Listening host |
| `XREGISTRY_PUBDEV_PORT` | `4200` | Alternative port variable |
| `XREGISTRY_PUBDEV_API_KEY` | — | API key for Bearer auth |
| `XREGISTRY_PUBDEV_BASEURL` | — | Override base URL for self-references |
| `XREGISTRY_PUBDEV_QUIET` | `false` | Suppress trace logging |

## Docker

```bash
# Build
docker build -f pubdev.Dockerfile -t xregistry-pubdev .

# Run
docker run -p 4200:4200 -e PORT=4200 xregistry-pubdev
```

## Caching

The server caches pub.dev API responses in `pubdev/cache/` using ETag-based HTTP caching. The cache persists across restarts and automatically revalidates stale entries.

## Pagination

The package list is bounded by the packages discovered from pub.dev search. The `Link` response header provides `first`, `prev`, `next`, and `last` relation links for traversal. The `count` field in the Link header reflects the actual count of matching packages in the local cache.

## Bridge Integration

When running behind the xRegistry bridge, the proxy is automatically registered as the `dartregistries` group type. No bridge configuration changes are required — the bridge discovers all group types by querying `/model` on each downstream.

Add to the bridge `DOWNSTREAMS_JSON`:
```json
{"url": "http://pubdev:4200", "apikey": "pubdev-api-key"}
```
