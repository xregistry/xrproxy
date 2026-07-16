# RubyGems xRegistry proxy

This service exposes the public RubyGems registry as an xRegistry-compatible read-only API.

- **Port:** 4000
- **Group type:** `rubyregistries`
- **Group id:** `rubygems.org`
- **Resource type:** `packages`
- **Spec version:** `1.0-rc1`

## Platform-safe version identity

RubyGems can publish multiple builds for the same version. This proxy makes those IDs collision-safe:

- `ruby` or `jruby` platform → `1.18.0`
- platform build → `1.18.0-x86_64-linux`
- `/` inside platform names is rewritten to `-`

Each version resource keeps both the raw `number` and `platform` attributes.

## Endpoints

- `GET /`
- `GET /model`
- `GET /rubyregistries`
- `GET /rubyregistries/rubygems.org`
- `GET /rubyregistries/rubygems.org/packages`
- `GET /rubyregistries/rubygems.org/packages/{name}`
- `GET /rubyregistries/rubygems.org/packages/{name}/versions`
- `GET /rubyregistries/rubygems.org/packages/{name}/versions/{versionId}`
- `GET /health`

Supported query parameters on package collections:

- `filter=name=rack`
- `inline=versions` or `inline=*`
- `offset`
- `limit` (max 100)
- `search`

Search is bounded to five upstream pages (`30` results per page). Version metadata is cached for one hour; search results are cached for five minutes.

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
