# AKS outputs — implements the shared output contract from _shared/outputs.tf

output "cluster_id" {
  description = "Provider-assigned unique resource ID for the AKS cluster."
  value       = azurerm_kubernetes_cluster.this.id
}

output "cluster_name" {
  description = "AKS cluster name."
  value       = azurerm_kubernetes_cluster.this.name
}

output "cluster_endpoint" {
  description = "HTTPS URL of the Kubernetes API server."
  # kube_config is marked sensitive by the provider. nonsensitive() is
  # intentional — the API server FQDN is publicly resolvable and safe to log.
  value     = nonsensitive(azurerm_kubernetes_cluster.this.kube_config[0].host)
  sensitive = false
}

output "cluster_ca_certificate" {
  description = <<-EOT
    Base64-encoded DER cluster CA certificate as returned by the azurerm
    provider (kube_config[0].cluster_ca_certificate). This value is NOT
    double-encoded; the azurerm provider already returns it in base64 form.
  EOT
  # nonsensitive() is needed to extract from the sensitive kube_config block;
  # the output is then re-marked sensitive to prevent accidental logging.
  value     = nonsensitive(azurerm_kubernetes_cluster.this.kube_config[0].cluster_ca_certificate)
  sensitive = true
}

output "kubeconfig" {
  description = "Raw kubeconfig YAML. Treat as a secret."
  value       = azurerm_kubernetes_cluster.this.kube_config_raw
  sensitive   = true
}

output "oidc_issuer_url" {
  description = "OIDC issuer URL used to federate workload identities."
  value       = var.workload_identity.enabled ? azurerm_kubernetes_cluster.this.oidc_issuer_url : ""
}

output "workload_identity_client_id" {
  description = "Entra Managed Identity client_id for workload identity binding."
  value       = var.workload_identity.enabled ? azurerm_user_assigned_identity.workload[0].client_id : ""
}

output "oci_registry_endpoint" {
  description = "Full OCI registry URL (https://login_server)."
  value       = "https://${azurerm_container_registry.this.login_server}"
}

output "oci_registry_login_server" {
  description = "ACR login server hostname."
  value       = azurerm_container_registry.this.login_server
}

output "static_egress_ips" {
  description = <<-EOT
    Public IP addresses attached to the single StandardV2 zone-redundant NAT
    Gateway. Count equals static_egress.ip_count (default 1); the StandardV2
    NAT Gateway is zone-redundant by design and serves all availability zones
    through a single resource, so no per-zone IPs are needed.
    Empty when static_egress.enabled = false.
  EOT
  value       = [for ip in azurerm_public_ip.egress : ip.ip_address]
}

output "dns_zone_name_servers" {
  description = "NS records for the managed DNS zone. Delegate from the parent zone."
  value       = length(azurerm_dns_zone.this) > 0 ? azurerm_dns_zone.this[0].name_servers : []
}

output "observability_endpoint" {
  description = "Azure Monitor workspace Prometheus query endpoint."
  value       = var.observability.enabled ? "https://${azurerm_monitor_workspace.this[0].query_endpoint}" : ""
}

output "monitor_workspace_id" {
  description = "Azure Monitor workspace resource ID used by managed Prometheus data collection rules."
  value       = var.observability.enabled ? azurerm_monitor_workspace.this[0].id : ""
}

output "resource_group_name" {
  description = "Resource group that contains all module resources."
  value       = azurerm_resource_group.this.name
}