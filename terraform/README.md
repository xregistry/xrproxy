# xregistry-terraform-wrapper

xRegistry 1.0-rc2 proxy for the public [Terraform Registry](https://registry.terraform.io/).

## Overview

| Attribute | Value |
|-----------|-------|
| Port | **3800** |
| Group type | `terraformregistries` |
| Group ID | `registry.terraform.io` |
| Resource types | `providers`, `modules` |
| Spec version | 1.0-rc2 |

## Resource IDs

| Type | ID format | Example |
|------|-----------|---------|
| Provider | `namespace~type` | `hashicorp~aws` |
| Module | `namespace~name~provider` | `terraform-aws-modules~vpc~aws` |

The `~` separator is URL-safe and never appears in Terraform registry names.

## API Endpoints

### Standard xRegistry endpoints

```
GET /                                                   Registry root
GET /model                                              Model definition
GET /capabilities                                       Server capabilities
GET /export                                             Full export redirect
GET /terraformregistries                                Group collection
GET /terraformregistries/registry.terraform.io          Group detail
```

### Providers

```
GET /terraformregistries/registry.terraform.io/providers
GET /terraformregistries/registry.terraform.io/providers/{namespace~type}
GET /terraformregistries/registry.terraform.io/providers/{namespace~type}/meta
GET /terraformregistries/registry.terraform.io/providers/{namespace~type}/versions
GET /terraformregistries/registry.terraform.io/providers/{namespace~type}/versions/{version}
```

Provider versions expose:
- `platforms[]` — per-OS/arch distribution entries with `download_url`, `shasum`, `shasums_url`, `shasums_signature_url`, `filename`
- `signing_keys.gpg_public_keys[]` — GPG key metadata for verifying the provider release
- `protocols[]` — supported Terraform plugin protocol versions

### Modules

```
GET /terraformregistries/registry.terraform.io/modules
GET /terraformregistries/registry.terraform.io/modules/{namespace~name~provider}
GET /terraformregistries/registry.terraform.io/modules/{namespace~name~provider}/meta
GET /terraformregistries/registry.terraform.io/modules/{namespace~name~provider}/versions
GET /terraformregistries/registry.terraform.io/modules/{namespace~name~provider}/versions/{version}
```

## Query parameters

All collection endpoints support:

| Parameter | Description |
|-----------|-------------|
| `limit` | Page size (default 25) |
| `offset` | Page offset |
| `filter` | Attribute filter expression (e.g. `type=aws`, `namespace=hashicorp`) |
| `sort` | Sort field with optional direction (e.g. `type=asc`) |

## Running locally

```bash
cd terraform
npm install
npm run build
npm start            # listens on :3800
```

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` / `XREGISTRY_TERRAFORM_PORT` | `3800` | Listen port |
| `HOST` | `0.0.0.0` | Bind address |
| `XREGISTRY_TERRAFORM_API_KEY` | — | Optional Bearer token |
| `BASE_URL` / `XREGISTRY_TERRAFORM_BASEURL` | derived | Self-referencing base URL |

## Running with Docker

```bash
docker build -f terraform.Dockerfile -t xregistry-terraform .
docker run -p 3800:3800 xregistry-terraform
```

## Caching

HTTP responses from the Terraform Registry are cached on disk (ETag-based) in `./cache/`.
The in-memory provider/module catalogue is refreshed every 6 hours in the background.

## Tests

```bash
cd terraform
npm test
```
