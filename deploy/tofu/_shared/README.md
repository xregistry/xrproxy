# Shared interface documentation for OpenTofu provider modules.
#
# This directory is NOT a deployable Terraform module.  It documents the
# stable variable and output contracts that every provider module (aks, eks,
# gke) must implement so callers can swap providers without changing
# application configuration.

## Interface contract

All provider modules accept the same set of input variables defined in
`variables.tf` and produce the same set of output values defined in
`outputs.tf`.  Provider-specific identifiers (subscription IDs, AWS account
IDs, GCP project IDs) live only inside provider modules and are never visible
to the application layer.

## Variable groups

| Group | Purpose |
|---|---|
| Identity | `cluster_name`, `environment`, `region` |
| Kubernetes | `kubernetes_version` |
| Capacity | `system_node_pool`, `workload_node_pool` |
| Network | `network` (CIDRs, availability zones) |
| OCI Registry | `oci_registry` |
| Workload Identity | `workload_identity` |
| Static Egress | `static_egress` |
| DNS | `dns` |
| Certificates | `certificates` |
| Observability | `observability` |
| Flux Bootstrap | `flux` |
| Labels | `tags` |

## Output contract

| Output | Type | Sensitive |
|---|---|---|
| `cluster_id` | string | no |
| `cluster_name` | string | no |
| `cluster_endpoint` | string | no |
| `cluster_ca_certificate` | string | yes |
| `kubeconfig` | string | yes |
| `oidc_issuer_url` | string | no |
| `workload_identity_client_id` | string | no |
| `oci_registry_endpoint` | string | no |
| `oci_registry_login_server` | string | no |
| `static_egress_ips` | list(string) | no |
| `dns_zone_name_servers` | list(string) | no |
| `observability_endpoint` | string | no |
