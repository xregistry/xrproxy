provider "azurerm" {
  features {}
}

provider "azapi" {}

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
