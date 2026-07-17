terraform {
  required_version = ">= 1.8.0"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
  }
}

# Non-production AKS example.
# Copy terraform.tfvars.example to terraform.tfvars and fill in your values.
# Do NOT apply this to a production environment without reviewing all settings.

module "aks" {
  source = "../../aks"

  cluster_name = var.cluster_name
  environment  = var.environment
  region       = var.region

  kubernetes_version = var.kubernetes_version

  system_node_pool   = var.system_node_pool
  workload_node_pool = var.workload_node_pool

  network      = var.network
  oci_registry = var.oci_registry

  workload_identity       = var.workload_identity
  static_egress           = var.static_egress
  dns                     = var.dns
  certificates            = var.certificates
  observability           = var.observability
  flux                    = var.flux
  cluster_access          = var.cluster_access
  azure_policy            = var.azure_policy
  key_vault_secrets_store = var.key_vault_secrets_store

  tags = var.tags
}

# ─── Outputs (pass-through from module) ────────────────────────────────────

output "cluster_endpoint" {
  value = module.aks.cluster_endpoint
}

output "oidc_issuer_url" {
  value = module.aks.oidc_issuer_url
}

output "workload_identity_client_id" {
  value = module.aks.workload_identity_client_id
}

output "oci_registry_login_server" {
  value = module.aks.oci_registry_login_server
}

output "static_egress_ips" {
  value = module.aks.static_egress_ips
}

output "dns_zone_name_servers" {
  value = module.aks.dns_zone_name_servers
}

output "resource_group_name" {
  value = module.aks.resource_group_name
}
