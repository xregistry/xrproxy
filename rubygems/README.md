# RubyGems xRegistry proxy

This service exposes the public RubyGems registry as an xRegistry-compatible read-only API.

- **Port:** 4000
- **Group type:** `rubyregistries`
- **Group id:** `rubygems.org`
- **Resource type:** `packages`
- **Spec version:** `1.0-rc2`

## Platform-safe version identity

RubyGems releases use xRegistry's built-in Resource Version mechanism (`maxversions: 0`, `setversionid: true`, `versionmode: createdat`); Versions are not nested Resources.


RubyGems can publish multiple builds for the same version. This proxy makes those IDs collision-safe:

- `ruby` or `jruby` platform → `1.18.0`
- platform build → `1.18.0-x86_64-linux`
- `/` inside platform names is rewritten to `-`

Collection pages are capped at ten complete Resources. Upstream requests are spaced below the public 10 requests/second limit with at most two in flight, and cached version histories avoid repeat hydration. A single history 429 falls back to the already-returned gem summary rather than failing or expanding the page fan-out.

Each Version keeps the raw `number` and `platform`, canonical owning `packageid`, and rc2 `ancestor` lineage. Package collections, exact Resources, `/meta`, and Version endpoints all use the same cached version snapshot: `createdat` ordering with a case-insensitive Version-ID tie-breaker. Resources project the newest snapshot Version and include `metaurl`, `versionsurl`, and `versionscount`; `defaultversionurl` and package-wide download/link aggregates are exposed only by `/meta`.

## Endpoints

- `GET /`
- `GET /model`
- `GET /modelsource`
- `GET /capabilities`
- `GET /rubyregistries`
- `GET /rubyregistries/rubygems.org`
- `GET /rubyregistries/rubygems.org/packages`
- `GET /rubyregistries/rubygems.org/packages/{name}`
- `GET /rubyregistries/rubygems.org/packages/{name}/meta`
- `GET /rubyregistries/rubygems.org/packages/{name}/versions`
- `GET /rubyregistries/rubygems.org/packages/{name}/versions/{versionId}`
- `GET /health`

Supported query parameters on package collections:

- `filter=name=rack`
- `filter=name=rails*` (prefix search)
- `offset`
- `limit` (max 10)
- `search`

`GET /capabilities` emits the complete xRegistry 1.0-rc2 read-only map and advertises only the implemented `filter` flag, pagination, `manual`/`createdat` version modes, and `xRegistry-json/1.0-rc2` schema serialization (Core, **Registry Capabilities**).

Package IDs are case-sensitive as required by xRegistry Core **Entity ID** rules. Entity caches preserve requested case, and an upstream canonical gem name that differs from the requested ID is returned as HTTP 404 rather than aliased.

Search pages are loaded as needed (`30` upstream results per page), up to 20 pages. Search offsets above `499` return HTTP 400. Repeated/no-progress upstream pages are detected to prevent unbounded loops, and `Link` headers advertise `next` only while more results may exist. Version metadata is cached for one hour; search results are cached for five minutes.

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
