# Google Kubernetes Engine (GKE) Module

Thin OpenTofu module that provisions a GKE Standard cluster and its supporting
GCP resources. Implements the [shared interface](../_shared/README.md).

## Day-0 conservative choices

| Concern | Choice | Rationale |
|---|---|---|
| Mode | Standard (not Autopilot) | Retains full node-level control for Flux DaemonSets and system workloads |
| Networking | VPC-native alias IP | Pod IPs are VPC-routable; no overlay; low latency |
| Workload identity | GKE Workload Identity Federation | Pods authenticate to GCP APIs using projected SA tokens; no downloaded service account keys |
| Node image | COS_CONTAINERD | Minimal, hardened OS; container-optimised |
| Release channel | REGULAR (prod) / RAPID (dev) | REGULAR = stability; RAPID = latest features for dev/staging |
| Egress | Cloud NAT + reserved static IPs | Predictable egress for allow-listing; Cloud Router for managed routing |
| Registry | Artifact Registry (Docker format) | Container Registry is deprecated; AR supports IAM per-repo and multi-format |
| Observability | Google Managed Prometheus (GMP) | No Prometheus operator needed; built into GKE monitoring stack |
| Gateway API | CHANNEL_STANDARD (enabled) | Required for cert-manager and advanced HTTP routing |
| Private nodes | Disabled at Day-0 | Enable `enable_private_nodes = true` for production hardening |
| Flux | Disabled by default | Enable after cluster health confirmed; safe Day-0 posture |

## Usage

```hcl
module "gke" {
  source = "../../deploy/tofu/gke"

  cluster_name   = "xrproxy"
  environment    = "prod"
  region         = "us-central1"
  gcp_project_id = "my-gcp-project"

  kubernetes_version = "1.31"

  system_node_pool = {
    vm_size   = "e2-standard-4"
    min_count = 2
    max_count = 4
  }

  workload_node_pool = {
    vm_size   = "e2-standard-8"
    min_count = 2
    max_count = 10
  }

  oci_registry = { name = "xrproxy-prod" }

  workload_identity = { enabled = true }
  static_egress     = { enabled = true, ip_count = 2 }
  dns               = { enabled = true, zone_name = "xrproxy.example.com" }
  observability     = { enabled = true }

  tags = { team = "platform" }
}
```

## Validation (no credentials required)

```bash
cd deploy/tofu/gke
tofu init -backend=false
tofu fmt -check
tofu validate
tofu test   # uses mock_provider; no GCP credentials needed
```
