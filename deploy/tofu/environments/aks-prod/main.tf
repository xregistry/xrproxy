provider "azurerm" {
  features {}
}

provider "azapi" {}

locals {
  front_door_origin_host = "20.31.198.77"
}

module "aks" {
  source = "../../aks"

  cluster_name       = "xrproxy"
  environment        = "prod"
  region             = "westeurope"
  kubernetes_version = "1.36"

  system_node_pool = {
    vm_size   = "Standard_D2ds_v5"
    min_count = 3
    max_count = 6
  }

  workload_node_pool = {
    vm_size   = "Standard_D4ds_v5"
    min_count = 3
    max_count = 9
  }

  network = {
    vpc_cidr           = "10.70.0.0/16"
    node_subnet_cidr   = "10.70.0.0/22"
    pod_cidr           = "10.244.0.0/16"
    service_cidr       = "10.96.0.0/16"
    dns_service_ip     = "10.96.0.10"
    availability_zones = ["1", "2", "3"]
    data_plane         = "cilium"
  }

  oci_registry = {
    name = "xrproxyweuprod"
    sku  = "premium"
  }

  workload_identity = {
    enabled    = true
    namespaces = ["default", "flux-system", "xrproxy"]
  }

  static_egress = {
    enabled  = true
    ip_count = 1
    nat_sku  = "StandardV2"
  }

  cluster_access = {
    private_cluster_enabled = true
    authorized_ip_ranges    = []
  }

  azure_policy = {
    enabled = true
  }

  key_vault_secrets_store = {
    enabled           = true
    rotation_enabled  = true
    rotation_interval = "2m"
  }

  dns = {
    enabled   = false
    zone_name = ""
  }

  certificates = {
    enabled        = false
    acme_email     = ""
    acme_server    = "https://acme-v02.api.letsencrypt.org/directory"
    cluster_issuer = "letsencrypt-prod"
  }

  observability = {
    enabled      = true
    namespace    = "monitoring"
    workspace_id = ""
  }

  flux = {
    enabled    = false
    git_url    = ""
    git_branch = "main"
    git_path   = "clusters/azure-prod"
  }

  tags = {
    workload = "xrproxy"
    owner    = "xregistry"
  }
}

resource "azapi_update_resource" "managed_gateway_ingress" {
  type        = "Microsoft.ContainerService/managedClusters@2026-02-01"
  resource_id = module.aks.cluster_id

  body = {
    properties = {
      ingressProfile = {
        gatewayAPI = {
          installation = "Standard"
        }
        webAppRouting = {
          enabled = true
          gatewayAPIImplementations = {
            appRoutingIstio = {
              mode = "Enabled"
            }
          }
        }
      }
    }
  }
}

resource "azurerm_monitor_data_collection_rule" "prometheus" {
  name                = "dcr-xrproxy-prod-prometheus"
  resource_group_name = module.aks.resource_group_name
  location            = "westeurope"

  destinations {
    monitor_account {
      monitor_account_id = module.aks.monitor_workspace_id
      name               = "managed-prometheus"
    }
  }

  data_flow {
    streams      = ["Microsoft-PrometheusMetrics"]
    destinations = ["managed-prometheus"]
  }

  data_sources {
    prometheus_forwarder {
      name    = "managed-prometheus"
      streams = ["Microsoft-PrometheusMetrics"]
    }
  }

  tags = {
    environment = "prod"
    workload    = "xrproxy"
    owner       = "xregistry"
  }
}

resource "azurerm_monitor_data_collection_rule_association" "prometheus" {
  name                    = "dcra-xrproxy-prod-prometheus"
  target_resource_id      = module.aks.cluster_id
  data_collection_rule_id = azurerm_monitor_data_collection_rule.prometheus.id
  description             = "Collect AKS Prometheus metrics in the production Azure Monitor workspace."
}

data "azurerm_network_security_group" "node_subnet" {
  name                = "NRMS-i6ldxgql2rnbuvnet-xrproxy-prod-snet-nodes-xrproxy-prod"
  resource_group_name = module.aks.resource_group_name
}

resource "azurerm_network_security_rule" "front_door_to_gateway" {
  name                        = "AllowAzureFrontDoorBackendToXrproxyGateway"
  priority                    = 100
  direction                   = "Inbound"
  access                      = "Allow"
  protocol                    = "Tcp"
  source_port_range           = "*"
  destination_port_range      = "80"
  source_address_prefix       = "AzureFrontDoor.Backend"
  destination_address_prefix  = "*"
  resource_group_name         = module.aks.resource_group_name
  network_security_group_name = data.azurerm_network_security_group.node_subnet.name
}

resource "azurerm_cdn_frontdoor_profile" "xrproxy" {
  name                     = "afd-xrproxy-prod"
  resource_group_name      = module.aks.resource_group_name
  sku_name                 = "Standard_AzureFrontDoor"
  response_timeout_seconds = 60

  tags = {
    environment = "prod"
    workload    = "xrproxy"
    owner       = "xregistry"
  }
}

resource "azurerm_cdn_frontdoor_endpoint" "xrproxy" {
  name                     = "xrproxy-prod"
  cdn_frontdoor_profile_id = azurerm_cdn_frontdoor_profile.xrproxy.id
  enabled                  = true

  tags = {
    environment = "prod"
    workload    = "xrproxy"
    owner       = "xregistry"
  }
}

resource "azurerm_cdn_frontdoor_origin_group" "aks" {
  name                                                      = "aks-xrproxy-prod"
  cdn_frontdoor_profile_id                                  = azurerm_cdn_frontdoor_profile.xrproxy.id
  session_affinity_enabled                                  = false
  restore_traffic_time_to_healed_or_new_endpoint_in_minutes = 0

  health_probe {
    interval_in_seconds = 30
    path                = "/health"
    protocol            = "Http"
    request_type        = "GET"
  }

  load_balancing {
    additional_latency_in_milliseconds = 0
    sample_size                        = 4
    successful_samples_required        = 3
  }
}

resource "azurerm_cdn_frontdoor_origin" "aks_gateway" {
  name                          = "aks-gateway"
  cdn_frontdoor_origin_group_id = azurerm_cdn_frontdoor_origin_group.aks.id
  enabled                       = true

  host_name                      = local.front_door_origin_host
  origin_host_header             = local.front_door_origin_host
  http_port                      = 80
  https_port                     = 443
  certificate_name_check_enabled = false
  priority                       = 1
  weight                         = 1000
}

resource "azurerm_cdn_frontdoor_rule_set" "registry_cache" {
  name                     = "registrycache"
  cdn_frontdoor_profile_id = azurerm_cdn_frontdoor_profile.xrproxy.id
}

resource "azurerm_cdn_frontdoor_rule" "registry_get_cache" {
  name                      = "CacheRegistryGets"
  cdn_frontdoor_rule_set_id = azurerm_cdn_frontdoor_rule_set.registry_cache.id
  order                     = 1
  behavior_on_match         = "Continue"

  depends_on = [
    azurerm_cdn_frontdoor_origin_group.aks,
    azurerm_cdn_frontdoor_origin.aks_gateway,
  ]

  conditions {
    request_method_condition {
      operator     = "Equal"
      match_values = ["GET"]
    }

    url_path_condition {
      operator     = "BeginsWith"
      match_values = ["/registry"]
      transforms   = ["Lowercase"]
    }
  }

  actions {
    route_configuration_override_action {
      cache_behavior                = "OverrideAlways"
      cache_duration                = "00:01:00"
      compression_enabled           = true
      forwarding_protocol           = "HttpOnly"
      query_string_caching_behavior = "UseQueryString"
    }
  }
}

resource "azurerm_cdn_frontdoor_route" "default" {
  name                          = "default"
  cdn_frontdoor_endpoint_id     = azurerm_cdn_frontdoor_endpoint.xrproxy.id
  cdn_frontdoor_origin_group_id = azurerm_cdn_frontdoor_origin_group.aks.id
  cdn_frontdoor_origin_ids      = [azurerm_cdn_frontdoor_origin.aks_gateway.id]
  cdn_frontdoor_rule_set_ids    = [azurerm_cdn_frontdoor_rule_set.registry_cache.id]

  enabled                = true
  forwarding_protocol    = "HttpOnly"
  https_redirect_enabled = true
  link_to_default_domain = true
  patterns_to_match      = ["/*"]
  supported_protocols    = ["Http", "Https"]
}

import {
  to = azurerm_cdn_frontdoor_profile.xrproxy
  id = "/subscriptions/041abda7-3870-4275-ae24-6bf4c5300523/resourceGroups/rg-xrproxy-prod/providers/Microsoft.Cdn/profiles/afd-xrproxy-prod"
}

import {
  to = azurerm_cdn_frontdoor_endpoint.xrproxy
  id = "/subscriptions/041abda7-3870-4275-ae24-6bf4c5300523/resourceGroups/rg-xrproxy-prod/providers/Microsoft.Cdn/profiles/afd-xrproxy-prod/afdEndpoints/xrproxy-prod"
}

import {
  to = azurerm_cdn_frontdoor_origin_group.aks
  id = "/subscriptions/041abda7-3870-4275-ae24-6bf4c5300523/resourceGroups/rg-xrproxy-prod/providers/Microsoft.Cdn/profiles/afd-xrproxy-prod/originGroups/aks-xrproxy-prod"
}

import {
  to = azurerm_cdn_frontdoor_origin.aks_gateway
  id = "/subscriptions/041abda7-3870-4275-ae24-6bf4c5300523/resourceGroups/rg-xrproxy-prod/providers/Microsoft.Cdn/profiles/afd-xrproxy-prod/originGroups/aks-xrproxy-prod/origins/aks-gateway"
}

import {
  to = azurerm_cdn_frontdoor_route.default
  id = "/subscriptions/041abda7-3870-4275-ae24-6bf4c5300523/resourceGroups/rg-xrproxy-prod/providers/Microsoft.Cdn/profiles/afd-xrproxy-prod/afdEndpoints/xrproxy-prod/routes/default"
}
