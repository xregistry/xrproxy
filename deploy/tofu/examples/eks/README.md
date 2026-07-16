# EKS Non-Production Example

Demonstrates the EKS module with minimal settings for a development environment.

## Prerequisites

- AWS CLI authenticated: `aws configure` or environment variables
- OpenTofu >= 1.8.0

## Steps

```bash
cd deploy/tofu/examples/eks
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars — set region to your target AWS region
tofu init
tofu plan -var-file=terraform.tfvars
tofu apply -var-file=terraform.tfvars
```

## Tear down

```bash
tofu destroy -var-file=terraform.tfvars
```
