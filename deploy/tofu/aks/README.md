# Azure Kubernetes Service (AKS) Module

Thin OpenTofu module that provisions an AKS cluster and its supporting cloud
resources. Implements the [shared interface](_shared/README.md) so callers can
switch to the EKS or GKE module by changing only the `source` path.

## Day-0 conservative choices

| Concern | Choice | Rationale |
|---|---|---|
| CNI | Azure CNI Overlay | Scales to large pod counts without consuming VNet IPs per pod |
| Cluster tier | Standard (prod) / Free (dev) | Standard is required for Uptime SLA and multi-zone control plane |
| Auto-upgrade | Channel `patch` | Keeps patch level current; minor upgrades are intentional |
| Node image | Channel `NodeImage` | Replaces nodes rather than in-place upgrade; reduces drift |
| Workload identity | Entra Workload ID + OIDC | Pods exchange projected SA tokens for Entra credentials; no static secrets |
| Egress | NAT Gateway (when enabled) | Predictable egress IPs; required for corporate allow-listing |
| Node OS | AzureLinux | Minimal attack surface; optimised for container workloads |
| ACR auth | Kubelet MSI + AcrPull role | Pull-only; no registry admin credentials in pods |
| Observability | Azure Monitor managed Prometheus | No operator deployment; PromQL endpoint exposed via output |
| Flux | Disabled by default | Enable after cluster health confirmed; safe Day-0 posture |

## Usage

```hcl
module "aks" {
  source = "../../deploy/tofu/aks"

  cluster_name = "xrproxy"
  environment  = "prod"
  region       = "eastus"

  kubernetes_version = "1.31"

  system_node_pool = {
    vm_size   = "Standard_D2ds_v5"
    min_count = 2
    max_count = 4
  }

  workload_node_pool = {
    vm_size   = "Standard_D4ds_v5"
    min_count = 2
    max_count = 10
  }

  oci_registry = {
    name = "xrproxyprodacr"
    sku  = "standard"
  }

  workload_identity = { enabled = true }
  static_egress     = { enabled = true, ip_count = 2 }
  dns               = { enabled = true, zone_name = "xrproxy.example.com" }
  observability     = { enabled = true }

  tags = { team = "platform", cost-center = "infra" }
}
```

## Inputs

See [variables.tf](variables.tf) for full descriptions.

| Name | Type | Default | Required |
|---|---|---|---|
| `cluster_name` | string | — | yes |
| `region` | string | — | yes |
| `oci_registry` | object | — | yes |
| `environment` | string | `"dev"` | no |
| `kubernetes_version` | string | `"1.31"` | no |
| `system_node_pool` | object | D2ds_v5, 2–4 | no |
| `workload_node_pool` | object | D4ds_v5, 1–6 | no |
| `network` | object | see variables.tf | no |
| `workload_identity` | object | enabled | no |
| `static_egress` | object | disabled, nat_sku=StandardV2 | no |
| `dns` | object | disabled | no |
| `certificates` | object | enabled | no |
| `observability` | object | enabled | no |
| `flux` | object | disabled | no |
| `tags` | map(string) | `{}` | no |

## Outputs

| Name | Sensitive | Description |
|---|---|---|
| `cluster_id` | no | AKS resource ID |
| `cluster_name` | no | AKS cluster name |
| `cluster_endpoint` | no | Kubernetes API URL |
| `cluster_ca_certificate` | **yes** | Base-64 CA cert |
| `kubeconfig` | **yes** | Raw kubeconfig YAML |
| `oidc_issuer_url` | no | OIDC issuer for workload identity |
| `workload_identity_client_id` | no | Entra MI client_id |
| `oci_registry_endpoint` | no | ACR URL (https://…) |
| `oci_registry_login_server` | no | ACR login server hostname |
| `static_egress_ips` | no | Public egress IP addresses |
| `dns_zone_name_servers` | no | NS records for delegation |
| `observability_endpoint` | no | Azure Monitor Prometheus endpoint |
| `resource_group_name` | no | Resource group name |

## Validation (no credentials required)

```bash
cd deploy/tofu/aks
tofu init -backend=false
tofu fmt -check
tofu validate
tofu test          # uses mock_provider; no Azure credentials needed
```
