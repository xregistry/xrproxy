locals {
  # ─── Resource naming ────────────────────────────────────────────────────────
  prefix = "${var.cluster_name}-${var.environment}"

  common_tags = merge(
    {
      cluster     = var.cluster_name
      environment = var.environment
      managed_by  = "opentofu"
      module      = "xrproxy/deploy/tofu/aks"
    },
    var.tags
  )

  # ─── ACR SKU normalisation ──────────────────────────────────────────────────
  acr_sku_map = {
    basic    = "Basic"
    standard = "Standard"
    premium  = "Premium"
  }
  acr_sku = lookup(local.acr_sku_map, lower(var.oci_registry.sku), "Standard")

  # ─── Availability zones ─────────────────────────────────────────────────────
  # AKS zone values are strings "1", "2", "3". Default to all three; callers
  # pass an explicit list to restrict to fewer zones.
  zones = length(var.network.availability_zones) > 0 ? var.network.availability_zones : ["1", "2", "3"]

  # ─── NAT Gateway SKU ─────────────────────────────────────────────────────────
  # Propagate static_egress.nat_sku as a local so it can be referenced in
  # both resource bodies and preconditions.
  nat_sku = var.static_egress.nat_sku

  # ─── Flux condition ─────────────────────────────────────────────────────────
  flux_enabled = var.flux.enabled && var.flux.git_url != ""
}