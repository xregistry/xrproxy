# AKS module static-plan test with mock providers.
# Run with: tofu test
# No cloud credentials are required — mock_provider intercepts all API calls.
#
# Egress design: StandardV2 NAT Gateway (zone-redundant) + StandardV2 public
# IPs. A single gateway serves all AZs; no per-zone subnet or node pool
# segregation is needed. The precondition rejects Standard (v1) NAT Gateway
# with multi-AZ node pools.
# Reference: https://learn.microsoft.com/azure/reliability/reliability-nat-gateway

mock_provider "azurerm" {
  mock_resource "azurerm_resource_group" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-xrproxy-test-dev"
    }
  }
  mock_resource "azurerm_virtual_network" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-xrproxy-test-dev/providers/Microsoft.Network/virtualNetworks/vnet-xrproxy-test-dev"
    }
  }
  mock_resource "azurerm_subnet" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-xrproxy-test-dev/providers/Microsoft.Network/virtualNetworks/vnet-xrproxy-test-dev/subnets/snet-nodes-xrproxy-test-dev"
    }
  }
  # StandardV2 public IPs — no zones attribute, zone-redundant by design.
  mock_resource "azurerm_public_ip" {
    defaults = {
      id         = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-xrproxy-test-dev/providers/Microsoft.Network/publicIPAddresses/pip-egress-xrproxy-test-dev-0"
      ip_address = "20.1.2.3"
    }
  }
  # Single StandardV2 NAT Gateway — zone-redundant, no zones attribute.
  mock_resource "azurerm_nat_gateway" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-xrproxy-test-dev/providers/Microsoft.Network/natGateways/natgw-xrproxy-test-dev"
    }
  }
  mock_resource "azurerm_nat_gateway_public_ip_association" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-xrproxy-test-dev/providers/Microsoft.Network/natGateways/natgw-xrproxy-test-dev/publicIPAddresses/pip"
    }
  }
  mock_resource "azurerm_subnet_nat_gateway_association" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-xrproxy-test-dev/providers/Microsoft.Network/virtualNetworks/vnet-xrproxy-test-dev/subnets/snet-nodes-xrproxy-test-dev"
    }
  }
  mock_resource "azurerm_user_assigned_identity" {
    defaults = {
      id           = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-xrproxy-test-dev/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-xrproxy-test-dev"
      client_id    = "00000000-0000-0000-0000-000000000010"
      tenant_id    = "00000000-0000-0000-0000-000000000011"
      principal_id = "00000000-0000-0000-0000-000000000012"
    }
  }
  mock_resource "azurerm_log_analytics_workspace" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-xrproxy-test-dev/providers/Microsoft.OperationalInsights/workspaces/law-xrproxy-test-dev"
    }
  }
  mock_resource "azurerm_monitor_workspace" {
    defaults = {
      id             = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-xrproxy-test-dev/providers/Microsoft.Monitor/accounts/amw-xrproxy-test-dev"
      query_endpoint = "amw-xrproxy-test-dev.eastus.prometheus.monitor.azure.com"
    }
  }
  mock_resource "azurerm_kubernetes_cluster" {
    defaults = {
      id   = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-xrproxy-test-dev/providers/Microsoft.ContainerService/managedClusters/aks-xrproxy-test-dev"
      fqdn = "aks-xrproxy-test-dev-xxxxxxxx.hcp.eastus.azmk8s.io"
      kube_config = [{
        host                   = "https://aks-xrproxy-test-dev-xxxxxxxx.hcp.eastus.azmk8s.io:443"
        client_certificate     = ""
        client_key             = ""
        cluster_ca_certificate = "dGVzdA=="
        password               = ""
        username               = ""
      }]
      kube_config_raw = "apiVersion: v1\nkind: Config"
      oidc_issuer_url = "https://eastus.oic.prod-aks.azure.com/00000000-0000-0000-0000-000000000000/xxxxxxxx/"
    }
  }
  mock_resource "azurerm_kubernetes_cluster_node_pool" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-xrproxy-test-dev/providers/Microsoft.ContainerService/managedClusters/aks-xrproxy-test-dev/agentPools/workload"
    }
  }
  mock_resource "azurerm_container_registry" {
    defaults = {
      id           = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-xrproxy-test-dev/providers/Microsoft.ContainerRegistry/registries/xrproxytestacr"
      login_server = "xrproxytestacr.azurecr.io"
    }
  }
  mock_resource "azurerm_role_assignment" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/providers/Microsoft.Authorization/roleAssignments/00000000-0000-0000-0000-000000000099"
    }
  }
  mock_resource "azurerm_dns_zone" {
    defaults = {
      id           = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-xrproxy-test-dev/providers/Microsoft.Network/dnsZones/xrproxy.example.com"
      name_servers = ["ns1-01.azure-dns.com.", "ns2-01.azure-dns.net.", "ns3-01.azure-dns.org.", "ns4-01.azure-dns.info."]
    }
  }
}

mock_provider "flux" {}

# ─── Minimal — no egress, Standard LB outbound ──────────────────────────────

run "validate_minimal" {
  command = plan

  variables {
    cluster_name = "xrproxy-test"
    region       = "eastus"
    oci_registry = {
      name = "xrproxytestacr"
    }
    system_node_pool = {
      vm_size   = "Standard_D2ds_v5"
      min_count = 3
      max_count = 6
    }
    workload_node_pool = {
      vm_size   = "Standard_D4ds_v5"
      min_count = 1
      max_count = 6
    }
  }

  assert {
    condition     = output.cluster_name == "aks-xrproxy-test-dev"
    error_message = "Expected cluster_name to follow aks-{cluster_name}-{environment} pattern."
  }

  assert {
    condition     = output.oci_registry_login_server == "xrproxytestacr.azurecr.io"
    error_message = "OCI registry login server did not match expected value."
  }

  assert {
    condition     = output.static_egress_ips == []
    error_message = "static_egress_ips should be empty when static_egress.enabled = false."
  }
}

# ─── StandardV2 zone-redundant NAT Gateway + 2 public IPs ───────────────────

run "validate_standardv2_static_egress" {
  command = plan

  variables {
    cluster_name = "xrproxy-test"
    region       = "eastus"
    oci_registry = {
      name = "xrproxytestacr"
    }
    system_node_pool = {
      vm_size   = "Standard_D2ds_v5"
      min_count = 3
      max_count = 6
    }
    workload_node_pool = {
      vm_size   = "Standard_D4ds_v5"
      min_count = 1
      max_count = 6
    }
    # StandardV2 (default): zone-redundant, no zones attribute on NAT GW or PIPs,
    # single gateway serves all 3 AZs.
    static_egress = {
      enabled  = true
      ip_count = 2
      nat_sku  = "StandardV2"
    }
    network = {
      availability_zones = ["1", "2", "3"]
    }
  }

  assert {
    condition     = length(output.static_egress_ips) == 2
    error_message = "Expected 2 static egress IPs (ip_count = 2, single zone-redundant NAT GW)."
  }
}

# ─── Standard v1 + single zone — precondition allows this ───────────────────
# Standard (v1) with a single AZ is acceptable: the gateway is zonal and the
# nodes are in the same zone. Not recommended for production; use StandardV2.

run "validate_standard_single_zone" {
  command = plan

  variables {
    cluster_name = "xrproxy-test"
    region       = "eastus"
    oci_registry = {
      name = "xrproxytestacr"
    }
    system_node_pool = {
      vm_size   = "Standard_D2ds_v5"
      min_count = 3
      max_count = 6
    }
    workload_node_pool = {
      vm_size   = "Standard_D4ds_v5"
      min_count = 1
      max_count = 6
    }
    static_egress = {
      enabled  = true
      ip_count = 1
      nat_sku  = "Standard"
    }
    # Single AZ: precondition passes (Standard v1 + 1 zone is allowed).
    network = {
      availability_zones = ["1"]
    }
  }
}

# ─── DNS zone ───────────────────────────────────────────────────────────────

run "validate_dns_enabled" {
  command = plan

  variables {
    cluster_name = "xrproxy-test"
    region       = "eastus"
    oci_registry = {
      name = "xrproxytestacr"
    }
    system_node_pool = {
      vm_size   = "Standard_D2ds_v5"
      min_count = 3
      max_count = 6
    }
    workload_node_pool = {
      vm_size   = "Standard_D4ds_v5"
      min_count = 1
      max_count = 6
    }
    dns = {
      enabled   = true
      zone_name = "xrproxy.example.com"
    }
  }

  assert {
    condition     = length(output.dns_zone_name_servers) == 4
    error_message = "Expected 4 Azure DNS name servers."
  }
}
# ─── Observability: created workspace (workspace_id = "") ────────────────────
# Verifies oms_agent is present and wired to the workspace created by this
# module when no pre-existing workspace_id is supplied.

run "validate_observability_created_workspace" {
  command = plan

  variables {
    cluster_name = "xrproxy-test"
    region       = "eastus"
    oci_registry = { name = "xrproxytestacr" }
    system_node_pool = {
      vm_size   = "Standard_D2ds_v5"
      min_count = 3
      max_count = 6
    }
    workload_node_pool = {
      vm_size   = "Standard_D4ds_v5"
      min_count = 1
      max_count = 6
    }
    observability = {
      enabled      = true
      workspace_id = "" # Empty — module creates the workspace
    }
  }

  assert {
    # oms_agent must be present when observability is enabled.
    condition     = length(azurerm_kubernetes_cluster.this.oms_agent) == 1
    error_message = "oms_agent block must be present when observability.enabled = true."
  }

  assert {
    # oms_agent must be wired to the workspace created by this module.
    condition     = azurerm_kubernetes_cluster.this.oms_agent[0].log_analytics_workspace_id == azurerm_log_analytics_workspace.this[0].id
    error_message = "oms_agent must use the created log analytics workspace when workspace_id is empty."
  }
}

# ─── Observability: supplied pre-existing workspace ───────────────────────────
# Verifies oms_agent is present and wired to the supplied workspace_id;
# the module must NOT create a second workspace in this case.

run "validate_observability_supplied_workspace" {
  command = plan

  variables {
    cluster_name = "xrproxy-test"
    region       = "eastus"
    oci_registry = { name = "xrproxytestacr" }
    system_node_pool = {
      vm_size   = "Standard_D2ds_v5"
      min_count = 3
      max_count = 6
    }
    workload_node_pool = {
      vm_size   = "Standard_D4ds_v5"
      min_count = 1
      max_count = 6
    }
    observability = {
      enabled      = true
      workspace_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/shared-rg/providers/Microsoft.OperationalInsights/workspaces/shared-law"
    }
  }

  assert {
    # oms_agent must be present even when workspace_id is supplied externally.
    condition     = length(azurerm_kubernetes_cluster.this.oms_agent) == 1
    error_message = "oms_agent must be present when observability.enabled = true even when workspace_id is pre-supplied."
  }

  assert {
    # oms_agent must use the supplied ID, not a freshly created workspace.
    condition     = azurerm_kubernetes_cluster.this.oms_agent[0].log_analytics_workspace_id == "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/shared-rg/providers/Microsoft.OperationalInsights/workspaces/shared-law"
    error_message = "oms_agent must be wired to the supplied workspace_id, not a new workspace."
  }

  assert {
    # No new Log Analytics Workspace should be created when one is supplied.
    condition     = length(azurerm_log_analytics_workspace.this) == 0
    error_message = "Module must not create a new Log Analytics Workspace when workspace_id is provided."
  }
}
# ─── Negative: Standard v1 + omitted zones (default expands to 3) ────────────
# Demonstrates the bug that the raw-var check missed: when availability_zones
# is omitted, var.network.availability_zones = [] (length 0) passed the old
# precondition, but local.zones resolves to ["1","2","3"] (length 3).
# The fixed precondition uses local.zones and correctly rejects this case.

run "reject_standard_v1_with_default_zones" {
  command = plan

  variables {
    cluster_name = "xrproxy-test"
    region       = "eastus"
    oci_registry = { name = "xrproxytestacr" }
    system_node_pool = {
      vm_size   = "Standard_D2ds_v5"
      min_count = 3
      max_count = 6
    }
    workload_node_pool = {
      vm_size   = "Standard_D4ds_v5"
      min_count = 1
      max_count = 6
    }
    static_egress = {
      enabled  = true
      ip_count = 1
      nat_sku  = "Standard" # v1 zonal — must be rejected
    }
    # network.availability_zones intentionally omitted; local.zones defaults
    # to ["1","2","3"]. The precondition must fire on local.zones, not on
    # the raw empty var which would give a false pass.
  }

  expect_failures = [azurerm_nat_gateway.this]
}