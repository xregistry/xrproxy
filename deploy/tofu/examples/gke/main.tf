terraform {
  required_version = ">= 1.8.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }
}

# Non-production GKE example.
# Copy terraform.tfvars.example to terraform.tfvars and fill in your values.

module "gke" {
  source = "../../gke"

  cluster_name   = var.cluster_name
  environment    = var.environment
  region         = var.region
  gcp_project_id = var.gcp_project_id

  kubernetes_version = var.kubernetes_version

  system_node_pool   = var.system_node_pool
  workload_node_pool = var.workload_node_pool

  network      = var.network
  oci_registry = var.oci_registry

  workload_identity = var.workload_identity
  static_egress     = var.static_egress
  dns               = var.dns
  certificates      = var.certificates
  observability     = var.observability
  flux              = var.flux
  cluster_access    = var.cluster_access

  tags = var.tags
}

output "cluster_endpoint" {
  value = module.gke.cluster_endpoint
}

output "oidc_issuer_url" {
  value = module.gke.oidc_issuer_url
}

output "workload_identity_client_id" {
  value = module.gke.workload_identity_client_id
}

output "oci_registry_login_server" {
  value = module.gke.oci_registry_login_server
}

output "static_egress_ips" {
  value = module.gke.static_egress_ips
}

output "dns_zone_name_servers" {
  value = module.gke.dns_zone_name_servers
}

output "vpc_network_name" {
  value = module.gke.vpc_network_name
}
