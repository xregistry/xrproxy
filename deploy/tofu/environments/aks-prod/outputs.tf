output "cluster_endpoint" {
  value = module.aks.cluster_endpoint
}

output "resource_group_name" {
  value = module.aks.resource_group_name
}

output "oci_registry_login_server" {
  value = module.aks.oci_registry_login_server
}

output "static_egress_ips" {
  value = module.aks.static_egress_ips
}

output "oidc_issuer_url" {
  value = module.aks.oidc_issuer_url
}

output "workload_identity_client_id" {
  value = module.aks.workload_identity_client_id
}
