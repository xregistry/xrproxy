# GKE thin module — Day-0 conservative choices
#
# Design decisions:
#   • Standard mode (not Autopilot): retains full node-level control for Flux
#     system workloads and DaemonSets (Prometheus node-exporter, etc.).
#   • GKE Workload Identity Federation: pods authenticate to GCP APIs using
#     projected service-account tokens without downloading service account keys.
#   • VPC-native cluster (alias IP): pod IPs are VPC-routable; no overlay.
#   • Cloud NAT with static external IPs: predictable egress for allow-listing.
#   • Artifact Registry (not Container Registry): Container Registry is
#     deprecated; Artifact Registry supports multi-format repos and IAM.
#   • Google Managed Prometheus (GMP): no Prometheus operator; metrics
#     forwarded to Cloud Monitoring; query endpoint exposed via output.
#   • Gateway API enabled by default: required for HTTP LB and cert-manager.
#   • Release channel REGULAR (prod) / RAPID (non-prod): REGULAR gives
#     stability; RAPID gets latest features faster for dev/staging.
#   • Flux bootstrap disabled by default: safe Day-0; enable after health check.

# ─── Enable required APIs ────────────────────────────────────────────────────

resource "google_project_service" "container" {
  project            = var.gcp_project_id
  service            = "container.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "artifactregistry" {
  project            = var.gcp_project_id
  service            = "artifactregistry.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "monitoring" {
  count              = var.observability.enabled ? 1 : 0
  project            = var.gcp_project_id
  service            = "monitoring.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "dns" {
  count              = var.dns.enabled ? 1 : 0
  project            = var.gcp_project_id
  service            = "dns.googleapis.com"
  disable_on_destroy = false
}

# ─── VPC ────────────────────────────────────────────────────────────────────

resource "google_compute_network" "this" {
  project                 = var.gcp_project_id
  name                    = "vpc-${local.prefix}"
  auto_create_subnetworks = false
  depends_on              = [google_project_service.container]
}

resource "google_compute_subnetwork" "nodes" {
  project       = var.gcp_project_id
  name          = "snet-nodes-${local.prefix}"
  network       = google_compute_network.this.id
  region        = var.region
  ip_cidr_range = var.network.node_subnet_cidr

  secondary_ip_range {
    range_name    = "pods"
    ip_cidr_range = var.network.pod_cidr
  }

  secondary_ip_range {
    range_name    = "services"
    ip_cidr_range = var.network.service_cidr
  }

  private_ip_google_access = true
}

# ─── Static egress (Cloud NAT + reserved IPs) ────────────────────────────────

resource "google_compute_address" "egress" {
  count   = var.static_egress.enabled ? var.static_egress.ip_count : 0
  project = var.gcp_project_id
  name    = "ip-egress-${local.prefix}-${count.index}"
  region  = var.region
}

resource "google_compute_router" "this" {
  count   = var.static_egress.enabled ? 1 : 0
  project = var.gcp_project_id
  name    = "router-${local.prefix}"
  region  = var.region
  network = google_compute_network.this.id
}

resource "google_compute_router_nat" "this" {
  count   = var.static_egress.enabled ? 1 : 0
  project = var.gcp_project_id
  name    = "nat-${local.prefix}"
  router  = google_compute_router.this[0].name
  region  = var.region

  nat_ip_allocate_option = "MANUAL_ONLY"
  nat_ips                = google_compute_address.egress[*].self_link

  source_subnetwork_ip_ranges_to_nat = "LIST_OF_SUBNETWORKS"
  subnetwork {
    name                    = google_compute_subnetwork.nodes.id
    source_ip_ranges_to_nat = ["ALL_IP_RANGES"]
  }
}

# ─── Artifact Registry (OCI) ────────────────────────────────────────────────

resource "google_artifact_registry_repository" "this" {
  project       = var.gcp_project_id
  location      = var.region
  repository_id = var.oci_registry.name
  format        = "DOCKER"
  labels        = local.common_labels
  depends_on    = [google_project_service.artifactregistry]
}

# ─── GKE cluster ─────────────────────────────────────────────────────────────

resource "google_container_cluster" "this" {
  project  = var.gcp_project_id
  name     = local.prefix
  location = var.region

  # Day-0: VPC-native; pod and service CIDRs from subnet secondary ranges.
  network    = google_compute_network.this.name
  subnetwork = google_compute_subnetwork.nodes.name

  ip_allocation_policy {
    cluster_secondary_range_name  = "pods"
    services_secondary_range_name = "services"
  }

  # Remove default node pool; use explicitly managed pools.
  remove_default_node_pool = true
  initial_node_count       = 1

  release_channel {
    channel = local.release_channel
  }

  min_master_version = var.kubernetes_version

  workload_identity_config {
    workload_pool = var.workload_identity.enabled ? "${var.gcp_project_id}.svc.id.goog" : null
  }

  # Gateway API required for cert-manager and multi-cluster traffic.
  gateway_api_config {
    channel = "CHANNEL_STANDARD"
  }

  # Managed Prometheus
  monitoring_config {
    enable_components = var.observability.enabled ? ["SYSTEM_COMPONENTS"] : []
    managed_prometheus {
      enabled = var.observability.enabled
    }
  }

  logging_config {
    enable_components = var.observability.enabled ? ["SYSTEM_COMPONENTS", "WORKLOADS"] : []
  }

  private_cluster_config {
    enable_private_nodes    = var.cluster_access.enable_private_nodes
    enable_private_endpoint = var.cluster_access.enable_private_endpoint
    # master_ipv4_cidr_block is required when enable_private_nodes = true.
    master_ipv4_cidr_block = var.cluster_access.enable_private_nodes ? var.cluster_access.master_ipv4_cidr_block : null
  }

  dynamic "master_authorized_networks_config" {
    for_each = length(var.cluster_access.master_authorized_networks) > 0 ? [1] : []
    content {
      dynamic "cidr_blocks" {
        for_each = var.cluster_access.master_authorized_networks
        content {
          cidr_block   = cidr_blocks.value.cidr_block
          display_name = cidr_blocks.value.display_name
        }
      }
    }
  }

  # ─── Reliability / security preconditions ──────────────────────────────────
  lifecycle {
    precondition {
      # A production cluster with a public control-plane endpoint and no
      # master_authorized_networks allows any internet host to attempt
      # connections to the Kubernetes API. Require either:
      #   a) Private endpoint (enable_private_endpoint = true), OR
      #   b) At least one authorized network CIDR.
      condition = !(
        var.environment == "prod" &&
        !var.cluster_access.enable_private_endpoint &&
        length(var.cluster_access.master_authorized_networks) == 0
      )
      error_message = <<-EOT
        Production GKE clusters with a public control-plane endpoint must
        restrict access via cluster_access.master_authorized_networks.
        An unrestricted public endpoint allows unauthenticated internet hosts
        to attack the Kubernetes API.
        Fix:
          a) Set cluster_access.master_authorized_networks with corporate
             egress CIDRs (recommended for internet-accessible clusters).
          b) Set cluster_access.enable_private_endpoint = true to disable
             the public endpoint entirely (requires VPN or Cloud Interconnect
             from management workstations).
      EOT
    }
  }

  depends_on = [google_project_service.container]
}

# ─── System node pool ─────────────────────────────────────────────────────────

resource "google_container_node_pool" "system" {
  project  = var.gcp_project_id
  cluster  = google_container_cluster.this.name
  location = var.region
  name     = "system"
  # node_locations honours network.availability_zones when specified; null
  # lets GKE distribute nodes across all region zones (the default).
  node_locations = local.node_locations
  node_count     = var.system_node_pool.min_count

  autoscaling {
    min_node_count = var.system_node_pool.min_count
    max_node_count = var.system_node_pool.max_count
  }

  node_config {
    machine_type = var.system_node_pool.vm_size
    image_type   = "COS_CONTAINERD"

    # Use node service account with minimal permissions
    service_account = google_service_account.node.email
    oauth_scopes    = ["https://www.googleapis.com/auth/cloud-platform"]

    workload_metadata_config {
      mode = var.workload_identity.enabled ? "GKE_METADATA" : "MODE_UNSPECIFIED"
    }

    labels = merge(local.common_labels, { "node-role" = "system" })

    taint {
      key    = "CriticalAddonsOnly"
      value  = "true"
      effect = "NO_SCHEDULE"
    }
  }

  management {
    auto_repair  = true
    auto_upgrade = true
  }

  upgrade_settings {
    max_surge       = 1
    max_unavailable = 0
  }
}

# ─── Workload node pool ──────────────────────────────────────────────────────

resource "google_container_node_pool" "workload" {
  project        = var.gcp_project_id
  cluster        = google_container_cluster.this.name
  location       = var.region
  name           = "workload"
  node_locations = local.node_locations

  autoscaling {
    min_node_count = var.workload_node_pool.min_count
    max_node_count = var.workload_node_pool.max_count
  }

  node_config {
    machine_type = var.workload_node_pool.vm_size
    image_type   = "COS_CONTAINERD"

    service_account = google_service_account.node.email
    oauth_scopes    = ["https://www.googleapis.com/auth/cloud-platform"]

    workload_metadata_config {
      mode = var.workload_identity.enabled ? "GKE_METADATA" : "MODE_UNSPECIFIED"
    }

    labels = merge(local.common_labels, { "node-role" = "workload" })
  }

  management {
    auto_repair  = true
    auto_upgrade = true
  }

  upgrade_settings {
    max_surge       = 1
    max_unavailable = 0
  }
}

# ─── Node service account ────────────────────────────────────────────────────

resource "google_service_account" "node" {
  project      = var.gcp_project_id
  account_id   = "sa-nodes-${local.prefix}"
  display_name = "GKE node SA for ${local.prefix}"
}

resource "google_project_iam_member" "node_log_writer" {
  project = var.gcp_project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.node.email}"
}

resource "google_project_iam_member" "node_metric_writer" {
  project = var.gcp_project_id
  role    = "roles/monitoring.metricWriter"
  member  = "serviceAccount:${google_service_account.node.email}"
}

resource "google_project_iam_member" "node_artifact_reader" {
  project = var.gcp_project_id
  role    = "roles/artifactregistry.reader"
  member  = "serviceAccount:${google_service_account.node.email}"
}

# ─── Workload identity service account ──────────────────────────────────────

resource "google_service_account" "workload" {
  count        = var.workload_identity.enabled ? 1 : 0
  project      = var.gcp_project_id
  account_id   = "sa-workload-${local.prefix}"
  display_name = "Workload identity SA for ${local.prefix}"
}

# Allow pods to impersonate the workload service account.
resource "google_service_account_iam_member" "workload_wi_binding" {
  for_each = var.workload_identity.enabled ? toset(var.workload_identity.namespaces) : toset([])

  service_account_id = google_service_account.workload[0].name
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${var.gcp_project_id}.svc.id.goog[${each.value}/workload-identity-sa]"
}

# ─── Cloud DNS ───────────────────────────────────────────────────────────────

resource "google_dns_managed_zone" "this" {
  count      = var.dns.enabled && var.dns.zone_name != "" ? 1 : 0
  project    = var.gcp_project_id
  name       = replace(var.dns.zone_name, ".", "-")
  dns_name   = "${var.dns.zone_name}."
  labels     = local.common_labels
  depends_on = [google_project_service.dns]
}

# ─── Flux bootstrap ─────────────────────────────────────────────────────────

resource "flux_bootstrap_git" "this" {
  count = local.flux_enabled ? 1 : 0

  path       = var.flux.git_path
  components = ["source-controller", "kustomize-controller", "helm-controller", "notification-controller"]
}
