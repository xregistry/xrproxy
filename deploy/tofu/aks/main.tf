# AKS thin module — Day-0 conservative choices
#
# Design decisions:
#   • Azure CNI Overlay: scales to large pod counts without consuming VNet IPs.
#   • Configurable network dataplane (network.data_plane):
#     "azure" (default): Azure CNI built-in dataplane + azure network policy.
#       Safe for existing clusters; dev/staging upgrades preserve the current
#       dataplane with no cluster replacement required.
#     "cilium": eBPF dataplane; kube-proxy replaced by Cilium. Cilium L3-L7
#       NetworkPolicy enforcement activated automatically. Requires overlay
#       mode (already set) and Kubernetes >= 1.25 (enforced by version
#       validation). Recommended for production; a lifecycle precondition
#       rejects environment = prod when data_plane != "cilium" — production
#       therefore fails closed until Cilium is explicitly opted in.
#     AKS and AzureRM support an in-place "azure" to "cilium" migration.
#       Test the rollout in non-production before applying it to production.
#   • Standard tier cluster (prod) / Free (dev).
#   • OIDC + Entra Workload Identity: no static secrets in pods.
#   • Distinct UserAssigned control-plane identity with Managed Identity
#     Operator permission over the kubelet identity.
#   • Explicit UserAssigned kubelet identity: deterministic ACR pull IAM.
#   • cluster_access: private cluster or authorized IP ranges enforced for prod
#     via lifecycle precondition — public unrestricted endpoint is rejected.
#   • azure_policy: disabled by default (dev-safe); enable for prod to enforce
#     admission controls.
#   • key_vault_secrets_store: CSI driver disabled by default; enable when
#     workloads mount Key Vault secrets. Rotation enabled by default when CSI
#     is on.
#   • StandardV2 NAT Gateway for static egress (zone-redundant, when enabled).
#   • Azure Monitor managed Prometheus.
#   • Auto-upgrade channel = "patch"; node OS channel = "NodeImage".
#   • Flux disabled by default (safe Day-0; enable in second apply).
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

resource "azurerm_user_assigned_identity" "control_plane" {
  name                = "id-control-plane-${local.prefix}"
  resource_group_name = azurerm_resource_group.this.name
  location            = azurerm_resource_group.this.location
  tags                = local.common_tags
}

resource "azurerm_role_assignment" "control_plane_kubelet" {
  scope                            = azurerm_user_assigned_identity.kubelet.id
  role_definition_name             = "Managed Identity Operator"
  principal_id                     = azurerm_user_assigned_identity.control_plane.principal_id
  skip_service_principal_aad_check = true
}

resource "azurerm_role_assignment" "control_plane_network" {
  scope                            = azurerm_subnet.nodes.id
  role_definition_name             = "Network Contributor"
  principal_id                     = azurerm_user_assigned_identity.control_plane.principal_id
  skip_service_principal_aad_check = true
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

  # ─── API server access ───────────────────────────────────────────────────
  # private_cluster_enabled creates a private endpoint; public endpoint is
  # disabled. A lifecycle precondition (below) enforces that production clusters
  # are either private OR have explicit authorized_ip_ranges.
  private_cluster_enabled = var.cluster_access.private_cluster_enabled

  # authorized_ip_ranges restricts the PUBLIC API server endpoint to specified
  # CIDRs. Only emitted when the cluster is not private and CIDRs are given;
  # omitting the block leaves AKS with no IP restriction (acceptable for dev).
  dynamic "api_server_access_profile" {
    for_each = !var.cluster_access.private_cluster_enabled && length(var.cluster_access.authorized_ip_ranges) > 0 ? [1] : []
    content {
      authorized_ip_ranges = var.cluster_access.authorized_ip_ranges
    }
  }

  # ─── Add-ons ─────────────────────────────────────────────────────────────
  # azure_policy_enabled: enforce cluster compliance via Azure Policy admission
  # controller. Disabled by default (dev-safe); enable for production.
  azure_policy_enabled = var.azure_policy.enabled

  # key_vault_secrets_provider: CSI driver for mounting Key Vault secrets as
  # volumes with optional automatic rotation.
  dynamic "key_vault_secrets_provider" {
    for_each = var.key_vault_secrets_store.enabled ? [1] : []
    content {
      secret_rotation_enabled  = var.key_vault_secrets_store.rotation_enabled
      secret_rotation_interval = var.key_vault_secrets_store.rotation_enabled ? var.key_vault_secrets_store.rotation_interval : null
    }
  }

  # ─── Configurable network dataplane: Azure CNI Overlay ───────────────────
  # network_data_plane: "azure" (default, safe for upgrades) or "cilium"
  #   (eBPF dataplane; replaces kube-proxy; recommended for production).
  # network_policy is set to the same value as network_data_plane so that
  #   policy enforcement is always consistent with the active dataplane.
  # Both require network_plugin_mode = "overlay" (already set above).
  # A lifecycle precondition (below) enforces that production clusters use
  # the Cilium dataplane.
  # AKS supports an in-place "azure" to "cilium" migration. Test the rollout
  # in non-production before applying it to production.
  network_profile {
    network_plugin      = "azure"
    network_plugin_mode = "overlay"
    network_data_plane  = var.network.data_plane
    network_policy      = var.network.data_plane
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
    identity_ids = [azurerm_user_assigned_identity.control_plane.id]
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

  # ─── Reliability / security preconditions ────────────────────────────────
  lifecycle {
    precondition {
      # Ensure at least one system node per availability zone.
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
    precondition {
      # Reject production clusters with an unrestricted public API server.
      # An unguarded public endpoint allows any internet host to attempt
      # connections to the Kubernetes control plane.
      # Pass this check by either:
      #   a) cluster_access.private_cluster_enabled = true  (no public endpoint)
      #   b) cluster_access.authorized_ip_ranges = ["<corp-cidr>", ...]
      condition = !(
        var.environment == "prod" &&
        !var.cluster_access.private_cluster_enabled &&
        length(var.cluster_access.authorized_ip_ranges) == 0
      )
      error_message = <<-EOT
        Production AKS clusters must have a restricted API server. Set either:
          a) cluster_access.private_cluster_enabled = true (recommended; disables
             the public endpoint entirely)
          b) cluster_access.authorized_ip_ranges = ["<corp-egress-cidr>/32", ...]
             (restricts the public endpoint to explicit corporate CIDRs)
        An unrestricted public API server exposes the Kubernetes control plane
        to unauthenticated connection attempts from the internet.
      EOT
    }
    precondition {
      # Require the Cilium eBPF dataplane for production clusters.
      # The Cilium dataplane provides enhanced network observability, L3-L7
      # policy enforcement, and eBPF-based performance. Production clusters
      # must explicitly opt in to Cilium; this precondition fails closed so
      # that a new prod cluster cannot be created with the default azure
      # dataplane by accident. Dev and staging clusters retain the azure
      # default and can upgrade to cilium independently.
      # AKS supports an in-place "azure" to "cilium" migration. Test the
      # rollout in non-production before applying it to production.
      condition     = !(var.environment == "prod" && var.network.data_plane != "cilium")
      error_message = <<-EOT
        Production AKS clusters must use the Cilium eBPF dataplane. Set:
          network = { data_plane = "cilium", ... }
        The Cilium dataplane provides L3-L7 NetworkPolicy enforcement and
        enhanced eBPF-based performance required for production workloads.
        AKS supports an in-place migration from "azure" to "cilium"; test the
        rollout in a non-production environment before applying to production.
      EOT
    }
  }

  depends_on = [
    azurerm_subnet_nat_gateway_association.nodes,
    azurerm_nat_gateway_public_ip_association.this,
    azurerm_container_registry.this,
    azurerm_role_assignment.control_plane_kubelet,
    azurerm_role_assignment.control_plane_network,
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