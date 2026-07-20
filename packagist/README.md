# xRegistry Packagist Proxy

Read-only [xRegistry 1.0-rc2](https://github.com/xregistry/spec/blob/main/core/spec.md) access to [Packagist](https://packagist.org/).

## Native identity mapping

The xRegistry hierarchy follows Composer's native `vendor/package` identity (xRegistry Core, **Registry Model** and **Entity ID** sections):

| Composer package | Group ID | Resource ID | Canonical path |
|---|---|---|---|
| `symfony/console` | `symfony` | `console` | `/composerregistries/symfony/packages/console` |
| `laravel/framework` | `laravel` | `framework` | `/composerregistries/laravel/packages/framework` |

Packagist package names contain exactly one slash and are canonical lowercase. Both entity IDs are slash-free. Identity is derived from the upstream package key/name; a differently-cased xRegistry entity ID receives HTTP 404, as required by rc2 case-sensitive lookup. The full value is preserved in `name` and `packagepath`, and `vendor` preserves the vendor. Exact package/version lookup calls Packagist directly and is not gated by discovery pagination. This follows xRegistry Core [`<SINGULAR>id` lookup rules](https://github.com/xregistry/spec/blob/v1.0-rc2/core/spec.md#singularid-id-attribute).

## Endpoints

| Method | Path |
|---|---|
| GET | `/` |
| GET | `/model` |
| GET | `/modelsource` |
| GET | `/capabilities` |
| GET | `/composerregistries` |
| GET | `/composerregistries/{vendor}` |
| GET | `/composerregistries/{vendor}/packages` |
| GET | `/composerregistries/{vendor}/packages/{package}` |
| GET | `/composerregistries/{vendor}/packages/{package}/meta` |
| GET | `/composerregistries/{vendor}/packages/{package}/versions` |
| GET | `/composerregistries/{vendor}/packages/{package}/versions/{versionid}` |
| GET | `/health` |

Group, package, and version collections support `limit`/`offset`; applicable collections support `filter`, `sort`, and `q`. Package-wide filter/sort is intentionally limited to catalogue fields (`packageid`, `vendor`, `name`, `packagepath`, `xid`, `epoch`). A detail-only expression such as `description=...` receives HTTP 400 instead of hydrating an entire vendor. A page is capped at 100 Resources, so collection serialization queues at most 100 package hydrations (two bounded p2 feeds each). Responses provide `X-Total-Count` and RFC 8288 pagination links. Group and package counts come from Packagist's complete package-name catalogue.

`GET /capabilities` uses the complete xRegistry 1.0-rc2 map and advertises only implemented `filter` and `sort` flags. The registry is read-only (`mutable: []`), supports pagination and `manual`/`createdat` version modes, and serializes `schemas` as `["xRegistry-json/1.0-rc2"]` (Core, **Registry Capabilities**).

## Public path migration (#203)

The old fixed-group identity is intentionally not canonical:

```text
OLD /composerregistries/packagist.org/packages/symfony~console
NEW /composerregistries/symfony/packages/console
```

The unambiguous old Resource shape (`packagist.org` plus a `vendor~package` ID, including percent-encoded forms) returns **HTTP 410 Gone** with a replacement. Replacement paths retain `/meta`, `/versions`, and `/versions/{versionid}` suffixes. The string `packagist.org` is not globally reserved as a Group ID, so a real Composer vendor with that name remains addressable and cannot collide with the migration sentinel.

## Version model

Versions use xRegistry's built-in Resource Version model (`maxversions: 0`, `setversionid: true`, `versionmode: createdat`), not a nested Resource definition. The stable `/p2/{package}.json` and development `/p2/{package}~dev.json` feeds are merged and deduplicated before ordering. Stable releases keep a safe Composer-normalized ID. Mutable `dev-*` IDs normally use `xv~d~<base64url(raw-alias)>~<base64url(full-source-reference)>`; this is reversible and does not collide when aliases sanitize alike or commits share a 12-character prefix. If that tuple would exceed xRegistry's 128-character Entity-ID limit, the ID uses `xv~d~h~<sha256-base64url(full-tuple)>`; the complete raw alias and source reference remain available as attributes. The raw alias remains in `version`, the full reference in lowercase `sourcereference`, and `immutable` is `false`. Other rc2 extension names are lowercase (`versionnormalized`, `requiredev`); Resource-only `currentversion` is exposed in Meta. Resource and Version lineage uses `ancestor`, and every Version includes canonical `packageid` (xRegistry Core, **Resources** and **Versions**). Ancestry is computed oldest-first by `createdat` with Version ID as the tie-breaker; an unsorted paginated Versions response is serialized by ascending `versionid`. The newest merged Version is the non-sticky default (`defaultversionsticky: false`), so a mutable upstream feed can advance it.

Compatibility note: old truncated dev Version IDs are intentionally not aliases for the new injective IDs; clients must rediscover the Versions collection. Stable safe IDs are unchanged.

## Configuration

| Variable | Default |
|---|---|
| `PORT` | `4100` |
| `HOST` | `0.0.0.0` |
| `PACKAGIST_URL` | `https://packagist.org` |
| `XREGISTRY_PACKAGIST_API_KEY` | unset |

## Build and test

```bash
cd packagist
npm ci
npm run build
npm test
```

From the repository root, build the image with `docker build -f packagist.Dockerfile -t xregistry-packagist .`.
