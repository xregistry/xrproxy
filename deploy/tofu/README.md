# OpenTofu modules — xrproxy Kubernetes infrastructure

Provider-neutral OpenTofu modules that provision Kubernetes clusters and their
supporting cloud resources for AKS (Azure), EKS (AWS), and GKE (GCP).

## Design principles

**Stable shared interface.** Every module accepts the same variable names and
produces the same output names. Application configuration never contains
provider-specific IDs, region strings, or API names.

**Thin provisioner.** Each module provisions exactly what a cluster needs:
the Kubernetes control plane, node pools, OCI registry, workload identity,
static egress, DNS zone, and Flux bootstrap wiring. Application workloads
are managed by Flux; this layer is Day-0 only.

**No credentials in code.** Provider authentication uses ambient credentials
(Azure CLI / AWS credentials file or environment / gcloud ADC). No secrets
are committed.

**All validation runs without cloud credentials.** `tofu fmt`, `tofu validate`,
and `tofu test` (via mock providers) run in CI on every pull request without
any cloud account access.

## Directory layout

```
deploy/tofu/
├── _shared/            # Canonical interface documentation (not a deployable module)
│   ├── README.md       # Interface contract
│   ├── variables.tf    # Common input variables
│   └── outputs.tf      # Common output contract
├── aks/                # Azure Kubernetes Service module
├── eks/                # Amazon EKS module
├── gke/                # Google GKE module
└── examples/
    ├── aks/            # Non-production AKS example
    ├── eks/            # Non-production EKS example
    └── gke/            # Non-production GKE example
```

## Shared interface

All modules implement the same inputs and outputs so callers can switch
providers by changing only `source`.

### Key inputs

| Variable | Type | Purpose |
|---|---|---|
| `cluster_name` | string | Cluster identifier (used as resource name prefix) |
| `environment` | string | `dev` / `staging` / `prod` |
| `region` | string | Provider-neutral region (mapped internally) |
| `kubernetes_version` | string | Target minor version e.g. `"1.31"` |
| `system_node_pool` | object | System node pool vm_size / min / max |
| `workload_node_pool` | object | Workload node pool vm_size / min / max |
| `network` | object | CIDRs and availability zones |
| `oci_registry` | object | Registry name and SKU/tier |
| `workload_identity` | object | Enable OIDC/IRSA/WIF and target namespaces |
| `static_egress` | object | Enable NAT/Cloud NAT and IP count |
| `dns` | object | Enable managed DNS zone and zone name |
| `certificates` | object | ACME email, server, issuer name |
| `observability` | object | Enable managed Prometheus and workspace ID |
| `flux` | object | Enable Flux bootstrap, git URL/branch/path |
| `tags` | map(string) | Resource labels |

### Key outputs

| Output | Sensitive | Description |
|---|---|---|
| `cluster_id` | no | Provider resource ID |
| `cluster_name` | no | Cluster name |
| `cluster_endpoint` | no | Kubernetes API URL |
| `cluster_ca_certificate` | **yes** | Base-64 CA certificate |
| `kubeconfig` | **yes** | kubeconfig YAML |
| `oidc_issuer_url` | no | OIDC issuer for workload identity |
| `workload_identity_client_id` | no | MI client_id / IAM role ARN / SA email |
| `oci_registry_endpoint` | no | Registry URL |
| `oci_registry_login_server` | no | Registry hostname |
| `static_egress_ips` | no | Egress IP list |
| `dns_zone_name_servers` | no | NS records for delegation |
| `observability_endpoint` | no | Metrics remote-write endpoint |

## Validation (no cloud credentials required)

```bash
# From repository root
cd deploy/tofu/aks   # or eks, gke
tofu init -backend=false
tofu fmt -check
tofu validate
tofu test            # mock_provider — no cloud account needed
```

CI runs all three automatically on every PR that touches `deploy/tofu/**`.
See [`.github/workflows/tofu-validate.yml`](../../.github/workflows/tofu-validate.yml).

## Provider-specific modules

| Module | Provider | Registry | Workload identity | Egress | DNS |
|---|---|---|---|---|---|
| [`aks/`](aks/README.md) | Azure | ACR | Entra Workload ID | NAT Gateway | Azure DNS |
| [`eks/`](eks/README.md) | AWS | ECR | IRSA / Pod Identity | Elastic IP + NAT | Route 53 |
| [`gke/`](gke/README.md) | GCP | Artifact Registry | GKE WIF | Cloud NAT | Cloud DNS |

## Conservative Day-0 choices common to all modules

- Auto-upgrade enabled (patch channel or managed channel)
- Flux bootstrap **disabled** by default — enable in a second apply after
  cluster health is confirmed
- Non-production examples use Let's Encrypt **staging** ACME server
- Static egress **disabled** by default — enable when outbound IP allow-listing
  is required
- DNS zone **disabled** by default — enable when a delegated zone is ready
