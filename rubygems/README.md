# RubyGems xRegistry proxy

This service exposes the public RubyGems registry as an xRegistry-compatible read-only API.

- **Port:** 4000
- **Group type:** `rubyregistries`
- **Group id:** `rubygems`
- **Resource type:** `packages`
- **Spec version:** `1.0-rc2`

## Platform-safe version identity

RubyGems releases use xRegistry's built-in Resource Version mechanism (`maxversions: 0`, `setversionid: true`, `versionmode: createdat`); Versions are not nested Resources.

RubyGems can publish multiple builds for the same version. This proxy follows the spec's identity rules:

- `ruby` platform → `1.18.0`
- any other platform, including `java` → `1.18.0-java`, `1.18.0-x86_64-linux`
- if `<version>-<platform>` would violate xRegistry Entity ID rules or exceed 128 characters, the proxy emits `xh~<sha256(version/platform)>`

Collection pages default to 50 Resources and accept `limit` values up to 1000, but pages are addressing/identity skeletons only (`packageid`, `name`, `xid`, `self`, `epoch`, `createdat`, `modifiedat`, `metaurl`, `versionsurl`) built directly from the full catalogue of gem names - no upstream gem/version metadata is fetched just to list a page. Full gemspec/version detail is fetched lazily, on demand, when a caller `GET`s an exact Resource (`/packages/{name}`), its `/meta`, or its `/versions`.

Each Version keeps the raw `number` and `platform`, canonical owning `packageid`, and rc2 `ancestor` lineage. Exact Resources, `/meta`, and Version endpoints all use the same cached version snapshot: `createdat` ordering with a case-insensitive Version-ID tie-breaker. Resources project the newest non-yanked snapshot Version when yanked state is known, surface declared gemspec URI metadata on the Version projection, and keep package-wide aggregates (`owners`, `project_uri`, `downloads`, `reverse_dependencies`, `defaultversionsticky`) on `/meta`.

## Full-catalogue package listing

Package collections (`GET /rubyregistries/rubygems/packages`) are backed by the RubyGems compact index names snapshot (`https://index.rubygems.org/names`) rather than a fixed sample or the upstream search API:

- The full, sorted, deduplicated name list is fetched once and persisted as a cache entry under the configured cache directory (`CACHE_DIR`, default `./cache`).
- Refreshes are conditional (`ETag`/`If-None-Match`, `Last-Modified`/`If-Modified-Since`), so steady-state polling exchanges a cheap `304` with upstream instead of re-downloading the multi-megabyte snapshot.
- If upstream is unreachable, the last-known snapshot keeps being served (subject to a multi-day staleness budget) instead of failing catalogue browsing.
- `filter=name=<gem>` (exact) and `filter=name=<prefix>*` are matched directly against the local name list - no upstream search crawling.
- `search=<term>` is matched as a case-insensitive substring against the local name list.
- Because matching is a bounded in-memory scan over an already-sorted snapshot, `offset`/`limit` paging returns an exact total (surfaced as `X-Total-Count`) with no artificial offset ceiling.

## Endpoints

- `GET /`
- `GET /model`
- `GET /modelsource`
- `GET /capabilities`
- `GET /rubyregistries`
- `GET /rubyregistries/rubygems`
- `GET /rubyregistries/rubygems/packages`
- `GET /rubyregistries/rubygems/packages/{name}`
- `GET /rubyregistries/rubygems/packages/{name}/meta`
- `GET /rubyregistries/rubygems/packages/{name}/versions`
- `GET /rubyregistries/rubygems/packages/{name}/versions/{versionId}`
- `GET /health`

Supported query parameters on package collections:

- `filter=name=rack` (exact match against the local names index)
- `filter=name=rails*` (prefix match against the local names index, case-insensitive)
- `offset` (no upper bound; bounded only by the size of the catalogue)
- `limit` (default 50, max 1000)
- `search` (substring match against the local names index)

`GET /capabilities` emits the complete xRegistry 1.0-rc2 read-only map and advertises only the implemented `filter` flag, pagination, `manual`/`createdat` version modes, and `xRegistry-json/1.0-rc2` schema serialization (Core, **Registry Capabilities**).

Package IDs are case-sensitive as required by xRegistry Core **Entity ID** rules. Entity caches preserve requested case, and an upstream canonical gem name that differs from the requested ID is returned as HTTP 404 rather than aliased.

`Link` headers advertise `prev`/`next` based on the exact total; there is no offset ceiling for catalogue browsing (`filter`/`search`/plain listing all resolve against the local names index). Version and owner metadata fetched for an exact Resource are cached for one hour; the full names index is refreshed at most every few minutes (conditional GET) and tolerates upstream outages for days by serving the last-known snapshot.

## Configuration

- `PORT` - listener port (default `4000`)
- `HOST` - bind host (default `0.0.0.0`)
- `BASE_URL` - optional external base URL override
- `RUBYGEMS_API_KEY` - not required for the public RubyGems API; reserved for future/private mirror scenarios

## Build and run

```bash
npm install
npm run build
npm test
npm start
```
