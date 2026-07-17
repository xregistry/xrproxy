locals {
  prefix = "${var.cluster_name}-${var.environment}"

  # GCP labels must be lowercase, max 63 chars, no spaces.
  common_labels = merge(
    {
      cluster     = var.cluster_name
      environment = var.environment
      managed-by  = "opentofu"
      module      = "xrproxy-deploy-tofu-gke"
    },
    { for k, v in var.tags : lower(replace(k, " ", "-")) => lower(replace(v, " ", "-")) }
  )

  # GKE availability zones: fully-qualified zone names (e.g. "us-central1-a").
  # When the caller supplies network.availability_zones, those values are used
  # verbatim as GKE node_locations. When empty, GKE distributes nodes across
  # all zones in the region (the recommended default).
  zones = length(var.network.availability_zones) > 0 ? var.network.availability_zones : [
    "${var.region}-a", "${var.region}-b", "${var.region}-c"
  ]

  # node_locations for node pools. null = GKE manages zone placement (default).
  # Non-null pins nodes to the caller-specified zones, honoring the shared
  # network.availability_zones input rather than discarding it.
  node_locations = length(var.network.availability_zones) > 0 ? var.network.availability_zones : null

  # GKE release channel — map kubernetes_version to channel.
  release_channel = var.environment == "prod" ? "REGULAR" : "RAPID"

  flux_enabled = var.flux.enabled && var.flux.git_url != ""
}
