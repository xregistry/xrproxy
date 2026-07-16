# Canonical shared output contract.
# Every provider module (aks, eks, gke) must produce each of these outputs
# with the types shown here.  Callers depend only on these names; switching
# providers requires no changes to consuming code.
#
# This file is documentation only — it is not a valid Terraform module root
# because it has no required_providers block.  Copy and implement each output
# in the provider-specific outputs.tf.

# ─── Cluster identity ─────────────────────────────────────────────────────────

# output "cluster_id" {
#   description = "Provider-assigned unique resource ID for the cluster."
#   value       = "<provider resource>.id"
# }

# output "cluster_name" {
#   description = "Cluster name as registered with the cloud provider."
#   value       = var.cluster_name
# }

# ─── Kubernetes access ────────────────────────────────────────────────────────

# output "cluster_endpoint" {
#   description = "HTTPS URL of the Kubernetes API server (no trailing slash)."
#   value       = "<provider resource>.kube_config[0].host"
#   sensitive   = false
# }

# output "cluster_ca_certificate" {
#   description = "Base-64-encoded cluster CA certificate."
#   value       = base64encode("<provider resource>.kube_config[0].cluster_ca_certificate")
#   sensitive   = true
# }

# output "kubeconfig" {
#   description = "Full kubeconfig YAML. Store in a secret; do not log."
#   value       = "<provider resource>.kube_config_raw"
#   sensitive   = true
# }

# ─── Workload identity ────────────────────────────────────────────────────────

# output "oidc_issuer_url" {
#   description = "OIDC issuer URL for the cluster (used to federate external identities)."
#   value       = "<provider resource>.oidc_issuer_url"
# }

# output "workload_identity_client_id" {
#   description = <<-EOT
#     Binding credential for workload identity:
#     • AKS  → User-Assigned Managed Identity client_id
#     • EKS  → IAM Role ARN (for IRSA / Pod Identity)
#     • GKE  → Workload Identity Service Account email
#   EOT
#   value = "<provider-specific identity resource>.client_id"
# }

# ─── OCI registry ─────────────────────────────────────────────────────────────

# output "oci_registry_endpoint" {
#   description = "Full OCI registry URL prefix (e.g. https://myacr.azurecr.io)."
#   value       = "https://<login_server>"
# }

# output "oci_registry_login_server" {
#   description = "Hostname of the OCI registry login server (e.g. myacr.azurecr.io)."
#   value       = "<provider resource>.login_server"
# }

# ─── Static egress ────────────────────────────────────────────────────────────

# output "static_egress_ips" {
#   description = "Ordered list of static public IPs used for cluster egress. Empty when static_egress.enabled = false."
#   value       = [for ip in <provider resources> : ip.ip_address]
# }

# ─── DNS ──────────────────────────────────────────────────────────────────────

# output "dns_zone_name_servers" {
#   description = "NS record values for the managed DNS zone. Delegate from the parent zone. Empty when dns.enabled = false."
#   value       = try(<provider resource>.name_servers, [])
# }

# ─── Observability ────────────────────────────────────────────────────────────

# output "observability_endpoint" {
#   description = "Remote-write / OTLP endpoint for the provider-managed metrics workspace. Empty string when observability.enabled = false."
#   value       = try(<provider resource>.workspace_endpoint, "")
# }
