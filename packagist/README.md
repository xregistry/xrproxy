# xRegistry Packagist Proxy

An [xRegistry 1.0-rc2](https://xregistry.io/spec/core/) compliant proxy for the [Packagist](https://packagist.org/) Composer package repository.

## Port

Default: **4100**

## Group Type

`composerregistries` (singular: `composerregistry`)

## Key Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Registry root / discovery document |
| GET | `/model` | xRegistry model document |
| GET | `/capabilities` | Capability advertisement |
| GET | `/composerregistries` | List of Composer registries |
| GET | `/composerregistries/packagist.org` | packagist.org group entity |
| GET | `/composerregistries/packagist.org/packages` | Package list (supports `?q=`, `?page=`, `?filter=name=<prefix>*`, `?sort=`) |
| GET | `/composerregistries/packagist.org/packages/:id` | Package metadata (supports `?inline=versions`) |
| GET | `/composerregistries/packagist.org/packages/:id/meta` | Package meta document |
| GET | `/composerregistries/packagist.org/packages/:id/versions` | All versions |
| GET | `/composerregistries/packagist.org/packages/:id/versions/:vid` | Specific version |
| GET | `/health` | Health check |

## Package ID Encoding

Packagist uses `vendor/package` naming. The forward slash is not permitted in xRegistry resource IDs, so it is encoded as `~`:

```
symfony/console  →  symfony~console
laravel/framework  →  laravel~framework
```

## Dev-* Version Identity (Critical Rule)

Packagist `dev-*` versions (e.g. `dev-main`, `dev-master`) are **mutable branch aliases**, not immutable releases. Their content changes every time the branch advances.

This proxy implements a **source-reference-qualified, collision-safe ID** for these versions:

```
versionid = "<alias>.<first12charsOfCommitSHA>"
```

Examples:
- `dev-main` at commit `deadbeef1234...` → versionid: `dev-main.deadbeef1234`
- `dev-main` at commit `cafebabe5678...` → versionid: `dev-main.cafebabe5678`

Each entity also exposes:
- `version`: the human-readable alias (`dev-main`)
- `sourceReference`: the full commit SHA
- `immutable: false` — explicitly flags the version as mutable

Stable tagged releases (e.g. `v7.1.0`, `11.0.0`) use `immutable: true` and the Composer-normalized version string as their versionid (e.g. `7.1.0.0`, `11.0.0.0`).

## Running Locally

```bash
cd packagist
npm install
npm run build
npm start
# or for development:
npm run start:dev
```

## Running with Docker

```bash
# From the repository root:
docker build -f packagist.Dockerfile -t xregistry-packagist .
docker run -p 4100:4100 xregistry-packagist
```

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `PORT` | `4100` | Listening port |
| `HOST` | `0.0.0.0` | Bind address |
| `PACKAGIST_URL` | `https://packagist.org` | Upstream Packagist URL |
| `XREGISTRY_PACKAGIST_API_KEY` | _(none)_ | Optional API key for access control |

## Tests

```bash
cd packagist
npm install
npm test
npm run test:coverage
```

## Caching

Responses from Packagist are cached on disk in `./cache/` with a default TTL of **6 hours**. Dev-* version searches respect this cache but the TTL is shorter for search results (1 hour) to accommodate more frequent updates.
