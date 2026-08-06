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

output "front_door_profile_id" {
  value = azurerm_cdn_frontdoor_profile.xrproxy.resource_guid
}

output "front_door_endpoint_hostname" {
  value = azurerm_cdn_frontdoor_endpoint.xrproxy.host_name
}

output "front_door_endpoint_url" {
  value = "https://${azurerm_cdn_frontdoor_endpoint.xrproxy.host_name}"
}
