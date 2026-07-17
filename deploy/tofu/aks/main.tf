# AKS thin module — Day-0 conservative choices
#
# Design decisions:
#   • Azure CNI Overlay: scales to large pod counts without consuming VNet IPs
#     per-pod; no node-level IP pre-allocation needed.
#   • Standard tier cluster (prod) / Free (dev): Standard required for Uptime
#     SLA and multi-zone control plane HA.
#   • OIDC + Entra Workload Identity: pods exchange projected SA tokens for
#     Entra credentials without static secrets.
#   • Explicit UserAssigned kubelet identity: deterministic IAM wiring (ACR
#     pull role) resolvable before the API server is reachable.
#
# ─── Static egress — StandardV2 NAT Gateway (zone-redundant) ─────────────────
#
#   Per the Azure reliability docs (June 2026):
#   https://learn.microsoft.com/azure/reliability/reliability-nat-gateway
#
#   StandardV2 NAT Gateway provides AUTOMATIC zone redundancy: a single
#   gateway instance spans all availability zones without any zone-pinning.
#   This is the recommended production configuration.
#
#   Standard v1 NAT Gateway is ZONAL. A single Standard gateway without an
#   explicit zone pin is "nonzonal" (Azure selects the zone arbitrarily) and
#   does NOT survive an AZ failure — the Azure docs explicitly advise against
#   this for production. If callers override nat_sku = "Standard" with
#   multi-zone nodes, a lifecycle precondition rejects the configuration.
#
#   StandardV2 requires StandardV2 public IP addresses; Standard public IPs
#   are incompatible with StandardV2 NAT Gateway. Both resources use
#   var.static_egress.nat_sku as their SKU so they always match.
#
#   Region limitation: StandardV2 is available in any Azure region that
#   supports Availability Zones. If the region does not support AZs, the
#   Azure API will reject the StandardV2 deployment with a clear error. There
#   is no silent fallback; the caller must either choose a supported region or
#   set static_egress.nat_sku = "Standard" and restrict to a single AZ.
#
#   Provider note: azurerm ~> 4.0 accepts "StandardV2" for both
#   azurerm_nat_gateway.sku_name and azurerm_public_ip.sku as of 4.81.0.
#   The schema validates the value string at tofu validate time.
#
#   • Azure Monitor managed Prometheus: no operator; PromQL endpoint exposed.
#   • Auto-upgrade channel = "patch"; node OS channel = "NodeImage".
#   • Flux disabled by default: safe Day-0; enable in second apply.

# ─── Resource group ─────────────────────────────────────────────────────────

resource "azurerm_resource_group" "this" {
  name     = "rg-${local.prefix}"
  location = var.region
  tags     = local.common_tags
}

# ─── Networking ─────────────────────────────────────────────────────────────

resource "azurerm_virtual_network" "this" {
  name                = "vnet-${local.prefix}"
  resource_group_name = azurerm_resource_group.this.name
  location            = azurerm_resource_group.this.location
  address_space       = [var.network.vpc_cidr]
  tags                = local.common_tags
}

# Single shared node subnet. With StandardV2 NAT Gateway the gateway is
# zone-redundant and subnets do not need to be per-zone. All nodes across all
# zones are connected through one subnet and one NAT Gateway.
resource "azurerm_subnet" "nodes" {
  name                 = "snet-nodes-${local.prefix}"
  resource_group_name  = azurerm_resource_group.this.name
  virtual_network_name = azurerm_virtual_network.this.name
  address_prefixes     = [var.network.node_subnet_cidr]
}

# ─── Static egress — StandardV2 zone-redundant NAT Gateway ──────────────────

# StandardV2 public IPs are REQUIRED with StandardV2 NAT Gateway.
# Standard SKU public IPs are incompatible with StandardV2 NAT Gateway.
# No zones attribute: StandardV2 resources are zone-redundant by design.
resource "azurerm_public_ip" "egress" {
  count = var.static_egress.enabled ? var.static_egress.ip_count : 0

  name                = "pip-egress-${local.prefix}-${count.index}"
  resource_group_name = azurerm_resource_group.this.name
  location            = azurerm_resource_group.this.location
  allocation_method   = "Static"
  # sku must match the NAT Gateway sku_name.
  # StandardV2: zone-redundant (no zones attribute).
  # Standard: nonzonal (not recommended; see module header).
  sku  = local.nat_sku
  tags = local.common_tags
  # Do NOT set zones for StandardV2: it is zone-redundant by design.
  # If nat_sku = "Standard" and the caller wants a zonal PIP they must
  # extend this module with a zones argument.
}

resource "azurerm_nat_gateway" "this" {
  count = var.static_egress.enabled ? 1 : 0

  name                    = "natgw-${local.prefix}"
  resource_group_name     = azurerm_resource_group.this.name
  location                = azurerm_resource_group.this.location
  sku_name                = local.nat_sku
  idle_timeout_in_minutes = 4
  tags                    = local.common_tags
  # Do NOT set zones for StandardV2: automatic zone redundancy is the default.
  # Setting zones on a StandardV2 NAT Gateway is not required and may be
  # rejected by the API.

  lifecycle {
    # Guard against creating a Standard v1 (zonal) NAT Gateway when nodes span
    # multiple AZs. A single Standard gateway serves one zone only; nodes in
    # other zones would lose outbound connectivity if that zone fails.
    # Solution: use nat_sku = "StandardV2" (zone-redundant, recommended) or
    # restrict availability_zones to a single zone and accept the single-AZ risk.
    precondition {
      # Guard against Standard v1 NAT Gateway with multi-zone nodes.
      # Uses local.zones (not var.network.availability_zones) because the
      # default var value is [] (empty), which expands to ["1","2","3"] in
      # local.zones. Checking the raw variable would pass silently when the
      # caller omits availability_zones and relies on the default three-zone
      # expansion — a false negative that leaves multi-zone nodes behind a
      # single zonal gateway.
      condition     = !(local.nat_sku == "Standard" && length(local.zones) > 1)
      error_message = <<-EOT
        Standard (v1) NAT Gateway is zonal: a single instance cannot survive an
        AZ failure when nodes span ${length(local.zones)} zones (resolved from
        network.availability_zones; default expands to ["1","2","3"]).
        To fix:
          a) Use nat_sku = "StandardV2" (recommended, zone-redundant).
          b) Set network.availability_zones = ["1"] to restrict to one zone
             (reduces availability; requires matching node pool zone pinning).
        Reference: https://learn.microsoft.com/azure/reliability/reliability-nat-gateway
      EOT
    }
  }
}

resource "azurerm_nat_gateway_public_ip_association" "this" {
  count = var.static_egress.enabled ? var.static_egress.ip_count : 0

  nat_gateway_id       = azurerm_nat_gateway.this[0].id
  public_ip_address_id = azurerm_public_ip.egress[count.index].id
}

resource "azurerm_subnet_nat_gateway_association" "nodes" {
  count = var.static_egress.enabled ? 1 : 0

  subnet_id      = azurerm_subnet.nodes.id
  nat_gateway_id = azurerm_nat_gateway.this[0].id
}

# ─── Workload identity ──────────────────────────────────────────────────────

resource "azurerm_user_assigned_identity" "workload" {
  count               = var.workload_identity.enabled ? 1 : 0
  name                = "id-workload-${local.prefix}"
  resource_group_name = azurerm_resource_group.this.name
  location            = azurerm_resource_group.this.location
  tags                = local.common_tags
}

resource "azurerm_user_assigned_identity" "kubelet" {
  name                = "id-kubelet-${local.prefix}"
  resource_group_name = azurerm_resource_group.this.name
  location            = azurerm_resource_group.this.location
  tags                = local.common_tags
}

# ─── OCI registry (ACR) ─────────────────────────────────────────────────────

resource "azurerm_container_registry" "this" {
  name                    = replace(var.oci_registry.name, "-", "")
  resource_group_name     = azurerm_resource_group.this.name
  location                = azurerm_resource_group.this.location
  sku                     = local.acr_sku
  zone_redundancy_enabled = local.acr_sku == "Premium"
  tags                    = local.common_tags
}

# ─── Observability workspace ────────────────────────────────────────────────

resource "azurerm_log_analytics_workspace" "this" {
  count               = var.observability.enabled && var.observability.workspace_id == "" ? 1 : 0
  name                = "law-${local.prefix}"
  resource_group_name = azurerm_resource_group.this.name
  location            = azurerm_resource_group.this.location
  sku                 = "PerGB2018"
  retention_in_days   = 30
  tags                = local.common_tags
}

resource "azurerm_monitor_workspace" "this" {
  count               = var.observability.enabled ? 1 : 0
  name                = "amw-${local.prefix}"
  resource_group_name = azurerm_resource_group.this.name
  location            = azurerm_resource_group.this.location
  tags                = local.common_tags
}

# ─── AKS cluster ────────────────────────────────────────────────────────────

resource "azurerm_kubernetes_cluster" "this" {
  name                = "aks-${local.prefix}"
  resource_group_name = azurerm_resource_group.this.name
  location            = azurerm_resource_group.this.location
  dns_prefix          = local.prefix
  kubernetes_version  = var.kubernetes_version
  sku_tier            = var.environment == "prod" ? "Standard" : "Free"

  automatic_upgrade_channel = "patch"
  node_os_upgrade_channel   = "NodeImage"
  node_resource_group       = "rg-nodes-${local.prefix}"

  oidc_issuer_enabled       = var.workload_identity.enabled
  workload_identity_enabled = var.workload_identity.enabled

  network_profile {
    network_plugin      = "azure"
    network_plugin_mode = "overlay"
    pod_cidr            = var.network.pod_cidr
    service_cidr        = var.network.service_cidr
    dns_service_ip      = var.network.dns_service_ip
    load_balancer_sku   = "standard"
    outbound_type       = var.static_egress.enabled ? "userAssignedNATGateway" : "loadBalancer"
  }

  # Single shared node subnet. With StandardV2 NAT Gateway this subnet is
  # zone-redundant so all nodes regardless of zone have identical egress paths.
  default_node_pool {
    name                         = "system"
    vm_size                      = var.system_node_pool.vm_size
    auto_scaling_enabled         = true
    min_count                    = var.system_node_pool.min_count
    max_count                    = var.system_node_pool.max_count
    vnet_subnet_id               = azurerm_subnet.nodes.id
    zones                        = local.zones
    os_sku                       = "AzureLinux"
    only_critical_addons_enabled = true

    upgrade_settings {
      max_surge = "33%"
    }
  }

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.kubelet.id]
  }

  kubelet_identity {
    client_id                 = azurerm_user_assigned_identity.kubelet.client_id
    object_id                 = azurerm_user_assigned_identity.kubelet.principal_id
    user_assigned_identity_id = azurerm_user_assigned_identity.kubelet.id
  }

  dynamic "monitor_metrics" {
    for_each = var.observability.enabled ? [1] : []
    content {
      annotations_allowed = null
      labels_allowed      = null
    }
  }

  dynamic "oms_agent" {
    # Always emit oms_agent when observability is enabled, regardless of whether
    # workspace_id was supplied (pre-existing) or created by this module.
    # Selecting between supplied vs created workspace avoids silently discarding
    # the agent when workspace_id is provided.
    for_each = var.observability.enabled ? [1] : []
    content {
      log_analytics_workspace_id = (
        var.observability.workspace_id != ""
        ? var.observability.workspace_id
        : azurerm_log_analytics_workspace.this[0].id
      )
      msi_auth_for_monitoring_enabled = true
    }
  }

  # ─── Reliability preconditions ────────────────────────────────────────────
  lifecycle {
    precondition {
      # Ensure at least one system node per availability zone.
      # With StandardV2 NAT Gateway the system pool spans all zones via a
      # single shared subnet. A zone failure removes nodes in that zone; if
      # min_count < len(zones) the remaining nodes may all land in one zone,
      # leaving kube-system and Flux without capacity in the failed zone.
      # Single-zone deployments (len=1) are exempt (min_count >= 1 is trivial).
      condition     = length(local.zones) <= 1 || var.system_node_pool.min_count >= length(local.zones)
      error_message = <<-EOT
        system_node_pool.min_count (${var.system_node_pool.min_count}) must be >= the
        number of availability zones (${length(local.zones)}) so that kube-system and
        Flux have capacity in every zone. A zone outage would otherwise remove all system
        node capacity from the affected zone.
        Fix: increase system_node_pool.min_count to at least ${length(local.zones)}, or
        reduce network.availability_zones to match your min_count budget.
      EOT
    }
  }

  depends_on = [
    azurerm_subnet_nat_gateway_association.nodes,
    azurerm_nat_gateway_public_ip_association.this,
    azurerm_container_registry.this,
  ]

  tags = local.common_tags
}

resource "azurerm_role_assignment" "acr_pull" {
  scope                = azurerm_container_registry.this.id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_user_assigned_identity.kubelet.principal_id
}

# ─── Workload node pool ─────────────────────────────────────────────────────

# Single multi-zone workload node pool. With StandardV2 NAT Gateway all zones
# share the same egress path; no per-zone node pool segregation is needed.
resource "azurerm_kubernetes_cluster_node_pool" "workload" {
  name                  = "workload"
  kubernetes_cluster_id = azurerm_kubernetes_cluster.this.id
  vm_size               = var.workload_node_pool.vm_size
  auto_scaling_enabled  = true
  min_count             = var.workload_node_pool.min_count
  max_count             = var.workload_node_pool.max_count
  vnet_subnet_id        = azurerm_subnet.nodes.id
  zones                 = local.zones
  os_sku                = "AzureLinux"

  upgrade_settings {
    max_surge = "33%"
  }

  tags = local.common_tags
}

# ─── DNS zone ───────────────────────────────────────────────────────────────

resource "azurerm_dns_zone" "this" {
  count               = var.dns.enabled && var.dns.zone_name != "" ? 1 : 0
  name                = var.dns.zone_name
  resource_group_name = azurerm_resource_group.this.name
  tags                = local.common_tags
}

# cert-manager is bootstrapped by Flux using var.certificates values.

# ─── Flux bootstrap ─────────────────────────────────────────────────────────

resource "flux_bootstrap_git" "this" {
  count      = local.flux_enabled ? 1 : 0
  path       = var.flux.git_path
  components = ["source-controller", "kustomize-controller", "helm-controller", "notification-controller"]
}

# ─── Monitor data-collection rule association ────────────────────────────────
# The monitor_metrics block enables Azure Managed Prometheus collection.
# Wiring to an Azure Monitor workspace requires a Data Collection Rule (DCR).
# Create azurerm_monitor_data_collection_rule and
# azurerm_monitor_data_collection_rule_association in the calling root module.