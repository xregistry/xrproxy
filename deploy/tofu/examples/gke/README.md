# GKE Non-Production Example

Demonstrates the GKE module with minimal settings for a development environment.

## Prerequisites

- `gcloud` CLI authenticated: `gcloud auth application-default login`
- Active project: `gcloud config set project <project-id>`
- Billing enabled on the project
- OpenTofu >= 1.8.0

## Steps

```bash
cd deploy/tofu/examples/gke
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars — set gcp_project_id to your project
tofu init
tofu plan -var-file=terraform.tfvars
tofu apply -var-file=terraform.tfvars
```

## Tear down

```bash
tofu destroy -var-file=terraform.tfvars
```
