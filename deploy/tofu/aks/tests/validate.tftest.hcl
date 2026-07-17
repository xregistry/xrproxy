# AKS module static-plan test with mock providers.
# Run with: tofu test
# No cloud credentials are required — mock_provider intercepts all API calls.

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
  mock_resource "azurerm_public_ip" {
    defaults = {
      id         = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-xrproxy-test-dev/providers/Microsoft.Network/publicIPAddresses/pip-egress-xrproxy-test-dev-0"
      ip_address = "20.1.2.3"
    }
  }
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

override_resource {
  target = azurerm_user_assigned_identity.kubelet
  values = {
    id           = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-xrproxy-test-dev/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-kubelet-xrproxy-test-dev"
    client_id    = "00000000-0000-0000-0000-000000000020"
    principal_id = "00000000-0000-0000-0000-000000000021"
  }
}

override_resource {
  target = azurerm_user_assigned_identity.control_plane
  values = {
    id           = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-xrproxy-test-dev/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-control-plane-xrproxy-test-dev"
    client_id    = "00000000-0000-0000-0000-000000000030"
    principal_id = "00000000-0000-0000-0000-000000000031"
  }
}

mock_provider "flux" {}

# ─── Helper variables reused across runs ────────────────────────────────────

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
}

# ─── Default dev config — open access, azure dataplane (safe default) ───────

run "validate_minimal" {
  command = plan

  assert {
    condition     = output.cluster_name == "aks-xrproxy-test-dev"
    error_message = "Expected cluster_name to follow aks-{cluster_name}-{environment} pattern."
  }

  assert {
    condition     = azurerm_user_assigned_identity.control_plane.name == "id-control-plane-xrproxy-test-dev"
    error_message = "Expected a dedicated control-plane identity."
  }

  assert {
    condition     = azurerm_user_assigned_identity.kubelet.name == "id-kubelet-xrproxy-test-dev"
    error_message = "Expected a dedicated kubelet identity."
  }

  assert {
    condition     = contains(azurerm_kubernetes_cluster.this.identity[0].identity_ids, azurerm_user_assigned_identity.control_plane.id)
    error_message = "AKS must use the control-plane identity instead of the kubelet identity."
  }

  assert {
    condition     = azurerm_role_assignment.control_plane_kubelet.scope == azurerm_user_assigned_identity.kubelet.id
    error_message = "Managed Identity Operator must be scoped to the kubelet identity."
  }

  assert {
    condition     = azurerm_role_assignment.control_plane_kubelet.principal_id == azurerm_user_assigned_identity.control_plane.principal_id
    error_message = "Managed Identity Operator must be assigned to the control-plane identity."
  }

  assert {
    condition     = azurerm_role_assignment.control_plane_kubelet.role_definition_name == "Managed Identity Operator"
    error_message = "The control-plane identity must receive the Managed Identity Operator role."
  }

  assert {
    condition     = output.static_egress_ips == []
    error_message = "static_egress_ips should be empty when static_egress.enabled = false."
  }

  # ─── Default dataplane assertions ────────────────────────────────────────
  # network.data_plane defaults to "azure" so dev/staging clusters can upgrade
  # without forcing cluster replacement. Production requires "cilium" (enforced
  # by lifecycle precondition).
  assert {
    condition     = azurerm_kubernetes_cluster.this.network_profile[0].network_data_plane == "azure"
    error_message = "Default network_data_plane must be \"azure\" for upgrade safety."
  }

  assert {
    condition     = azurerm_kubernetes_cluster.this.network_profile[0].network_policy == "azure"
    error_message = "Default network_policy must be \"azure\", consistent with the default dataplane."
  }

  # ─── Default cluster_access assertions ───────────────────────────────────
  assert {
    condition     = azurerm_kubernetes_cluster.this.private_cluster_enabled == false
    error_message = "Default private_cluster_enabled should be false."
  }

  # No api_server_access_profile emitted when authorized_ip_ranges is empty.
  assert {
    condition     = length(azurerm_kubernetes_cluster.this.api_server_access_profile) == 0
    error_message = "api_server_access_profile must not be emitted when authorized_ip_ranges is empty."
  }

  # ─── Default add-on assertions ───────────────────────────────────────────
  assert {
    condition     = azurerm_kubernetes_cluster.this.azure_policy_enabled == false
    error_message = "azure_policy_enabled should default to false."
  }

  assert {
    condition     = length(azurerm_kubernetes_cluster.this.key_vault_secrets_provider) == 0
    error_message = "key_vault_secrets_provider must not be emitted when key_vault_secrets_store.enabled = false."
  }
}

# ─── StandardV2 static egress ────────────────────────────────────────────────

run "validate_standardv2_static_egress" {
  command = plan

  variables {
    static_egress = { enabled = true, ip_count = 2, nat_sku = "StandardV2" }
    network       = { availability_zones = ["1", "2", "3"] }
  }

  assert {
    condition     = length(output.static_egress_ips) == 2
    error_message = "Expected 2 static egress IPs (ip_count = 2)."
  }
}

# ─── Standard v1 with single AZ — precondition allows ───────────────────────

run "validate_standard_single_zone" {
  command = plan

  variables {
    static_egress = { enabled = true, ip_count = 1, nat_sku = "Standard" }
    network       = { availability_zones = ["1"] }
    system_node_pool = {
      vm_size   = "Standard_D2ds_v5"
      min_count = 1
      max_count = 4
    }
  }
}

# ─── DNS zone ────────────────────────────────────────────────────────────────

run "validate_dns_enabled" {
  command = plan

  variables {
    dns = { enabled = true, zone_name = "xrproxy.example.com" }
  }

  assert {
    condition     = length(output.dns_zone_name_servers) == 4
    error_message = "Expected 4 Azure DNS name servers."
  }
}

# ─── Authorized IP ranges wired into api_server_access_profile ───────────────

run "validate_authorized_ips" {
  command = plan

  variables {
    cluster_access = {
      private_cluster_enabled = false
      authorized_ip_ranges    = ["10.0.0.0/8", "192.168.1.0/24"]
    }
  }

  assert {
    condition     = azurerm_kubernetes_cluster.this.private_cluster_enabled == false
    error_message = "private_cluster_enabled should be false when authorized IPs are used."
  }

  assert {
    # api_server_access_profile block must be emitted when CIDRs are specified.
    condition     = length(azurerm_kubernetes_cluster.this.api_server_access_profile) == 1
    error_message = "api_server_access_profile must be emitted when authorized_ip_ranges is non-empty."
  }

  assert {
    condition     = azurerm_kubernetes_cluster.this.api_server_access_profile[0].authorized_ip_ranges == toset(["10.0.0.0/8", "192.168.1.0/24"])
    error_message = "authorized_ip_ranges was not wired into api_server_access_profile."
  }
}

# ─── Private cluster (no api_server_access_profile even if IPs given) ────────

run "validate_private_cluster" {
  command = plan

  variables {
    cluster_access = {
      private_cluster_enabled = true
      authorized_ip_ranges    = []
    }
  }

  assert {
    condition     = azurerm_kubernetes_cluster.this.private_cluster_enabled == true
    error_message = "private_cluster_enabled should be true when requested."
  }

  assert {
    # No api_server_access_profile for private clusters (no public endpoint).
    condition     = length(azurerm_kubernetes_cluster.this.api_server_access_profile) == 0
    error_message = "api_server_access_profile must not be emitted for private clusters."
  }
}

# ─── Azure Policy add-on ─────────────────────────────────────────────────────

run "validate_azure_policy" {
  command = plan

  variables {
    azure_policy = { enabled = true }
  }

  assert {
    condition     = azurerm_kubernetes_cluster.this.azure_policy_enabled == true
    error_message = "azure_policy_enabled must be true when azure_policy.enabled = true."
  }
}

# ─── Key Vault CSI driver with rotation ──────────────────────────────────────

run "validate_kv_csi" {
  command = plan

  variables {
    key_vault_secrets_store = {
      enabled           = true
      rotation_enabled  = true
      rotation_interval = "5m"
    }
  }

  assert {
    condition     = length(azurerm_kubernetes_cluster.this.key_vault_secrets_provider) == 1
    error_message = "key_vault_secrets_provider must be emitted when key_vault_secrets_store.enabled = true."
  }

  assert {
    condition     = azurerm_kubernetes_cluster.this.key_vault_secrets_provider[0].secret_rotation_enabled == true
    error_message = "secret_rotation_enabled must be wired from key_vault_secrets_store.rotation_enabled."
  }

  assert {
    condition     = azurerm_kubernetes_cluster.this.key_vault_secrets_provider[0].secret_rotation_interval == "5m"
    error_message = "secret_rotation_interval must be wired from key_vault_secrets_store.rotation_interval."
  }
}

# ─── Observability: created workspace ────────────────────────────────────────

run "validate_observability_created_workspace" {
  command = plan

  variables {
    observability = { enabled = true, workspace_id = "" }
  }

  assert {
    condition     = length(azurerm_kubernetes_cluster.this.oms_agent) == 1
    error_message = "oms_agent must be present when observability.enabled = true."
  }

  assert {
    condition     = azurerm_kubernetes_cluster.this.oms_agent[0].log_analytics_workspace_id == azurerm_log_analytics_workspace.this[0].id
    error_message = "oms_agent must use the created workspace when workspace_id is empty."
  }
}

# ─── Observability: supplied pre-existing workspace ──────────────────────────

run "validate_observability_supplied_workspace" {
  command = plan

  variables {
    observability = {
      enabled      = true
      workspace_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/shared-rg/providers/Microsoft.OperationalInsights/workspaces/shared-law"
    }
  }

  assert {
    condition     = length(azurerm_kubernetes_cluster.this.oms_agent) == 1
    error_message = "oms_agent must be present even when workspace_id is pre-supplied."
  }

  assert {
    condition     = azurerm_kubernetes_cluster.this.oms_agent[0].log_analytics_workspace_id == "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/shared-rg/providers/Microsoft.OperationalInsights/workspaces/shared-law"
    error_message = "oms_agent must be wired to the supplied workspace_id."
  }

  assert {
    condition     = length(azurerm_log_analytics_workspace.this) == 0
    error_message = "No new workspace should be created when workspace_id is provided."
  }
}

# ─── NAT SKU precondition uses local.zones (not raw var) ────────────────────

run "reject_standard_v1_with_default_zones" {
  command = plan

  variables {
    static_egress = { enabled = true, ip_count = 1, nat_sku = "Standard" }
    # network.availability_zones intentionally omitted; local.zones expands to
    # ["1","2","3"]. The precondition must fire on local.zones, not the raw var.
  }

  expect_failures = [azurerm_nat_gateway.this]
}

# ─── Negative: prod + public endpoint + no authorized CIDRs ─────────────────

run "reject_prod_open_endpoint" {
  command = plan

  variables {
    environment = "prod"
    cluster_access = {
      private_cluster_enabled = false
      authorized_ip_ranges    = [] # empty in prod = rejected
    }
    network = {
      # Satisfy the production dataplane requirement so this run isolates the
      # unrestricted API-server precondition.
      data_plane = "cilium"
    }
  }

  # The API-server access lifecycle precondition must fire.
  expect_failures = [azurerm_kubernetes_cluster.this]
}

# ─── Negative: prod + azure dataplane rejected by Cilium precondition ────────

run "reject_prod_azure_dataplane" {
  command = plan

  variables {
    environment = "prod"
    system_node_pool = {
      vm_size   = "Standard_D4ds_v5"
      min_count = 3
      max_count = 6
    }
    cluster_access = {
      # API server access is valid; only the Cilium precondition should fire.
      private_cluster_enabled = true
      authorized_ip_ranges    = []
    }
    network = {
      data_plane = "azure" # explicitly azure in prod → must be rejected
    }
  }

  # Cilium lifecycle precondition must fire.
  expect_failures = [azurerm_kubernetes_cluster.this]
}

# ─── Positive: prod with Cilium dataplane + authorized CIDRs passes ──────────

run "validate_prod_authorized_ips" {
  command = plan

  variables {
    environment = "prod"
    system_node_pool = {
      vm_size   = "Standard_D4ds_v5"
      min_count = 3
      max_count = 6
    }
    cluster_access = {
      private_cluster_enabled = false
      authorized_ip_ranges    = ["203.0.113.0/24"]
    }
    network = {
      data_plane = "cilium" # required for production
    }
    azure_policy            = { enabled = true }
    key_vault_secrets_store = { enabled = true, rotation_enabled = true, rotation_interval = "2m" }
  }

  assert {
    condition     = azurerm_kubernetes_cluster.this.private_cluster_enabled == false
    error_message = "private_cluster_enabled should be false when using authorized CIDRs."
  }

  assert {
    condition     = length(azurerm_kubernetes_cluster.this.api_server_access_profile) == 1
    error_message = "api_server_access_profile must be emitted for prod with authorized CIDRs."
  }

  assert {
    condition     = azurerm_kubernetes_cluster.this.azure_policy_enabled == true
    error_message = "azure_policy_enabled should be true for production."
  }

  assert {
    condition     = length(azurerm_kubernetes_cluster.this.key_vault_secrets_provider) == 1
    error_message = "key_vault_secrets_provider must be present when enabled."
  }

  assert {
    condition     = azurerm_kubernetes_cluster.this.network_profile[0].network_data_plane == "cilium"
    error_message = "Production cluster must use Cilium dataplane."
  }

  assert {
    condition     = azurerm_kubernetes_cluster.this.network_profile[0].network_policy == "cilium"
    error_message = "Production cluster must use Cilium network policy."
  }
}

# ─── Explicit Cilium dataplane on dev/staging ────────────────────────────────

run "validate_cilium_dataplane_dev" {
  command = plan

  variables {
    network = { data_plane = "cilium" }
  }

  assert {
    condition     = azurerm_kubernetes_cluster.this.network_profile[0].network_data_plane == "cilium"
    error_message = "network_data_plane must be \"cilium\" when network.data_plane = \"cilium\"."
  }

  assert {
    condition     = azurerm_kubernetes_cluster.this.network_profile[0].network_policy == "cilium"
    error_message = "network_policy must be \"cilium\" when network.data_plane = \"cilium\"."
  }
}

# ─── Negative: kubernetes_version 1.24 rejected ──────────────────────────────

run "reject_kubernetes_version_1_24" {
  command = plan

  variables {
    kubernetes_version = "1.24"
  }

  # Variable validation must reject versions < 1.25.
  expect_failures = [var.kubernetes_version]
}

# ─── Negative: kubernetes_version 1.20 rejected ──────────────────────────────

run "reject_kubernetes_version_1_20" {
  command = plan

  variables {
    kubernetes_version = "1.20"
  }

  expect_failures = [var.kubernetes_version]
}