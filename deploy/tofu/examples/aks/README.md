# AKS Non-Production Example

Demonstrates the AKS module with minimal settings suitable for a development
environment. Uses the Let's Encrypt staging server, no static egress, and no
DNS zone.

## Prerequisites

- Azure CLI authenticated: `az login`
- Active subscription: `az account set --subscription <id>`
- OpenTofu >= 1.8.0

## Steps

```bash
cd deploy/tofu/examples/aks
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars — set oci_registry.name to something globally unique
tofu init
tofu plan -var-file=terraform.tfvars
tofu apply -var-file=terraform.tfvars
```

## Tear down

```bash
tofu destroy -var-file=terraform.tfvars
```
