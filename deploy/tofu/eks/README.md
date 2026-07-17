# Amazon Elastic Kubernetes Service (EKS) Module

Thin OpenTofu module that provisions an EKS cluster and its supporting AWS
resources. Implements the [shared interface](../_shared/README.md).

## Day-0 conservative choices

| Concern | Choice | Rationale |
|---|---|---|
| Node management | Managed node groups | AWS handles node lifecycle, AMI updates, and replacement; no custom launch templates required at Day-0 |
| Networking | VPC CNI (native ENI) | Low latency; no overlay; nodes and pods share the VPC address space |
| Add-ons | vpc-cni, coredns, kube-proxy, eks-pod-identity-agent (AWS-managed) | Independent lifecycle from Kubernetes version; auto-updated by AWS |
| Workload identity | IRSA / Pod Identity (OIDC federation) | Pods exchange projected SA tokens for IAM role credentials; no AWS_ACCESS_KEY_ID in pods |
| Egress | Elastic IPs + NAT Gateway (when enabled) | Predictable egress IPs; required for allow-listing in enterprise/regulated networks |
| Registry | ECR with IMMUTABLE tags and scan-on-push | Prevents tag overwriting; early vulnerability detection |
| Observability | Amazon Managed Prometheus (AMP) | No Prometheus operator; remote-write endpoint exposed via output |
| API access | Public + private endpoint | Public endpoint restricted to known CIDRs in production; private for in-cluster traffic |
| Flux | Disabled by default | Enable after cluster health confirmed; safe Day-0 posture |

## Usage

```hcl
module "eks" {
  source = "../../deploy/tofu/eks"

  cluster_name = "xrproxy"
  environment  = "prod"
  region       = "us-east-1"

  kubernetes_version = "1.31"

  system_node_pool = {
    vm_size   = "m6i.large"
    min_count = 2
    max_count = 4
  }

  workload_node_pool = {
    vm_size   = "m6i.xlarge"
    min_count = 2
    max_count = 10
  }

  oci_registry = { name = "xrproxy-prod" }

  workload_identity = { enabled = true }
  static_egress     = { enabled = true, ip_count = 2 }
  dns               = { enabled = true, zone_name = "xrproxy.example.com" }
  observability     = { enabled = true }

  tags = { team = "platform", cost-center = "infra" }
}
```

## Validation (no credentials required)

```bash
cd deploy/tofu/eks
tofu init -backend=false
tofu fmt -check
tofu validate
tofu test   # uses mock_provider; no AWS credentials needed
```
