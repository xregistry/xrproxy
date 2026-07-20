# xRegistry Terraform Registry Proxy

Read-only [xRegistry 1.0-rc2](https://github.com/xregistry/spec/blob/main/core/spec.md) access to providers and modules on `registry.terraform.io` (port **3800**).

## Native identity mapping

Terraform namespaces are xRegistry groups:

| Terraform source | Group ID | Resource ID | xRegistry path |
|---|---|---|---|
| provider `hashicorp/aws` | `hashicorp` | `aws` | `/terraformregistries/hashicorp/providers/aws` |
| module `terraform-aws-modules/vpc/aws` | `terraform-aws-modules` | `vpc~aws` | `/terraformregistries/terraform-aws-modules/modules/vpc~aws` |

Provider IDs are their type/name. A module's native `name/provider` pair is encoded as `name~provider`. Terraform registry identifiers permit alphanumerics, `_`, and `-`, but not `~`, making this encoding reversible and collision-free. Group and resource IDs are slash-free. Canonical addresses remain in `source`; `namespace`, `name`/`type`, `provider`, and `registryhost` preserve each component.

Exact provider/module/version lookup always resolves through the authoritative versions endpoint, independently of the bounded discovery snapshot. Namespace detail is validated independently through exact provider/module search before a Group or child collection is returned, so real namespaces such as `philips-software` work group-first while arbitrary syntactically valid names return 404. Successful exact child resolution registers its canonical provider/module in the bounded catalogue. Discovery is deduplicated case-insensitively, but xRegistry lookup remains case-sensitive: wrong-case Group and Resource IDs return 404, never redirect. A true upstream 404 remains 404, while timeouts and outages propagate as 504/502 rather than being collapsed into “not found”.

## Registry host and multi-host aggregation

This proxy intentionally targets one fixed host, `registry.terraform.io`, recorded as `registryhost` on groups and resources. Group IDs therefore need only the native namespace. Separate single-host proxy instances naturally have separate xRegistry roots. A future service aggregating multiple hosts must disambiguate groups (for example, collision-free `host~namespace` IDs) while retaining `registryhost` and `namespace`; it must not merge equal namespaces from different hosts silently.

## Endpoints

```text
GET /
GET /model
GET /modelsource
GET /capabilities
GET /terraformregistries
GET /terraformregistries/{namespace}
GET /terraformregistries/{namespace}/providers
GET /terraformregistries/{namespace}/providers/{type}
GET /terraformregistries/{namespace}/providers/{type}/meta
GET /terraformregistries/{namespace}/providers/{type}/versions
GET /terraformregistries/{namespace}/providers/{type}/versions/{version}
GET /terraformregistries/{namespace}/modules
GET /terraformregistries/{namespace}/modules/{name~provider}
GET /terraformregistries/{namespace}/modules/{name~provider}/meta
GET /terraformregistries/{namespace}/modules/{name~provider}/versions
GET /terraformregistries/{namespace}/modules/{name~provider}/versions/{version}
```

Group, provider, module, and version collections support `limit`/`offset` and provide RFC 8288 links. Provider/module discovery is deliberately bounded rather than pretending that the first 100 popular entries are complete: those collections emit `X-Collection-Complete: false` and omit non-authoritative root, group, and HTTP counts. Exact Version collections are authoritative and retain `X-Total-Count`.

The service does not advertise xRegistry `filter` or `sort`. Either parameter on group, provider, module, or Version collections receives HTTP 400; it is never silently ignored or evaluated against an incomplete snapshot. Default pagination order is deterministic by entity ID.

`GET /capabilities` emits every known xRegistry 1.0-rc2 capability with required types. It reports a read-only registry (`mutable: []`), pagination, `manual`/`semver` version modes, and `xRegistry-json/1.0-rc2`; its `flags` array is empty because no xRegistry query flag is implemented (Core, **Registry Capabilities**).

Version arrays from Terraform are treated as unordered. Provider and module defaults are recomputed from each upstream versions response, so both models set `setdefaultversionsticky: false` and `/meta` emits `defaultversionsticky: false`. Providers and modules are sorted ascending by strict SemVer precedence before default/latest and `ancestor` predecessor selection. Invalid non-SemVer values sort lexically before valid SemVer values; if all values are non-SemVer, the lexical maximum is the default. Build metadata is only a deterministic tie-breaker. This makes pagination deterministic and follows xRegistry Core **Versions** (`ancestor`, `isdefault`) semantics.

## Public path migration (#203)

```text
OLD /terraformregistries/registry.terraform.io/providers/hashicorp~aws
NEW /terraformregistries/hashicorp/providers/aws

OLD /terraformregistries/registry.terraform.io/modules/terraform-aws-modules~vpc~aws
NEW /terraformregistries/terraform-aws-modules/modules/vpc~aws
```

All requests under the removed fixed group—including percent-encoded sentinel/resource forms—return **HTTP 410 Gone** with a `replacement` path/template. Replacements use the actual `providers`/`modules` resource type and retain `/meta`, `/versions`, and Version suffixes. Malformed percent escapes return 400, not 500. Legacy paths are not interpreted as canonical identities.

## Configuration

| Variable | Default |
|---|---|
| `PORT` / `XREGISTRY_TERRAFORM_PORT` | `3800` |
| `HOST` | `0.0.0.0` |
| `XREGISTRY_TERRAFORM_API_KEY` | unset |
| `BASE_URL` | derived from request |

Search and version responses use an ETag-aware disk cache in `./cache`; the discovery snapshot refreshes every six hours.

## Build and test

```bash
cd terraform
npm ci
npm run build
npm test
```
