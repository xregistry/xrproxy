# GKE module static-plan test with mock providers.
# Run with: tofu test
# No GCP credentials are required — mock_provider intercepts all API calls.
#
# KNOWN LIMITATION — cluster_ca_certificate and kubeconfig:
#   master_auth is computed-only; mock_provider cannot set it. Both outputs
#   return null in mock-plan mode. Types verified by tofu validate; values
#   verified after real apply.

mock_provider "google" {
  mock_resource "google_project_service" {
    defaults = { id = "my-project/container.googleapis.com" }
  }
  mock_resource "google_compute_network" {
    defaults = {
      id        = "projects/my-project/global/networks/vpc-xrproxy-test-dev"
      self_link = "https://www.googleapis.com/compute/v1/projects/my-project/global/networks/vpc-xrproxy-test-dev"
    }
  }
  mock_resource "google_compute_subnetwork" {
    defaults = {
      id        = "projects/my-project/regions/us-central1/subnetworks/snet-nodes-xrproxy-test-dev"
      self_link = "https://www.googleapis.com/compute/v1/projects/my-project/regions/us-central1/subnetworks/snet-nodes-xrproxy-test-dev"
    }
  }
  mock_resource "google_container_cluster" {
    defaults = {
      id       = "projects/my-project/locations/us-central1/clusters/xrproxy-test-dev"
      endpoint = "34.1.2.3"
      name     = "xrproxy-test-dev"
    }
  }
  mock_resource "google_container_node_pool" {
    defaults = {
      id = "projects/my-project/locations/us-central1/clusters/xrproxy-test-dev/nodePools/system"
    }
  }
  mock_resource "google_artifact_registry_repository" {
    defaults = {
      id   = "projects/my-project/locations/us-central1/repositories/xrproxy-test"
      name = "xrproxy-test"
    }
  }
  mock_resource "google_service_account" {
    defaults = {
      id        = "projects/my-project/serviceAccounts/sa-nodes-xrproxy-test-dev@my-project.iam.gserviceaccount.com"
      email     = "sa-nodes-xrproxy-test-dev@my-project.iam.gserviceaccount.com"
      unique_id = "123456789012345678901"
      name      = "projects/my-project/serviceAccounts/sa-nodes-xrproxy-test-dev@my-project.iam.gserviceaccount.com"
    }
  }
  mock_resource "google_project_iam_member" {
    defaults = {
      id = "my-project/roles/logging.logWriter/serviceAccount:sa-nodes@my-project.iam.gserviceaccount.com"
    }
  }
  mock_resource "google_service_account_iam_member" {
    defaults = {
      id = "projects/my-project/serviceAccounts/sa-workload@my-project.iam.gserviceaccount.com/roles/iam.workloadIdentityUser"
    }
  }
  mock_resource "google_compute_address" {
    defaults = {
      id      = "projects/my-project/regions/us-central1/addresses/ip-egress-xrproxy-test-dev-0"
      address = "34.5.6.7"
    }
  }
  mock_resource "google_compute_router" {
    defaults = {
      id   = "projects/my-project/regions/us-central1/routers/router-xrproxy-test-dev"
      name = "router-xrproxy-test-dev"
    }
  }
  mock_resource "google_compute_router_nat" {
    defaults = {
      id = "projects/my-project/regions/us-central1/routers/router-xrproxy-test-dev/natgw-xrproxy-test-dev"
    }
  }
  mock_resource "google_dns_managed_zone" {
    defaults = {
      id           = "projects/my-project/managedZones/xrproxy-example-com"
      name_servers = ["ns-cloud-a1.googledomains.com.", "ns-cloud-a2.googledomains.com.", "ns-cloud-a3.googledomains.com.", "ns-cloud-a4.googledomains.com."]
    }
  }
}

mock_provider "flux" {}

# ─── Minimal — public nodes, default zone placement (node_locations = null) ──

run "validate_minimal" {
  command = plan

  variables {
    cluster_name   = "xrproxy-test"
    region         = "us-central1"
    gcp_project_id = "my-project"
    oci_registry   = { name = "xrproxy-test" }
    system_node_pool = {
      vm_size   = "e2-standard-4"
      min_count = 2
      max_count = 4
    }
    workload_node_pool = {
      vm_size   = "e2-standard-8"
      min_count = 1
      max_count = 6
    }
    # availability_zones empty → node_locations = null (GKE manages placement)
  }

  assert {
    condition     = output.cluster_name == "xrproxy-test-dev"
    error_message = "Expected cluster_name to follow {cluster_name}-{environment} pattern."
  }

  assert {
    condition     = output.oci_registry_login_server == "us-central1-docker.pkg.dev"
    error_message = "OCI registry login server did not match expected Artifact Registry format."
  }

  assert {
    condition     = google_container_cluster.this.private_cluster_config[0].enable_private_nodes == false
    error_message = "Default cluster_access should produce enable_private_nodes = false."
  }

  assert {
    condition     = google_container_cluster.this.private_cluster_config[0].enable_private_endpoint == false
    error_message = "Default cluster_access should produce enable_private_endpoint = false."
  }

  # When no availability_zones are specified, node_locations resolves to an
  # empty set (google provider schema: Computed set(string)). GKE distributes
  # nodes across all region zones without pinning.
  assert {
    condition     = length(google_container_node_pool.system.node_locations) == 0
    error_message = "node_locations must be empty when network.availability_zones is unset (GKE manages placement)."
  }

  assert {
    condition     = length(google_container_node_pool.workload.node_locations) == 0
    error_message = "workload node_locations must be empty when network.availability_zones is unset."
  }
}

# ─── Explicit zones — node_locations wired from network.availability_zones ───

run "validate_explicit_zones" {
  command = plan

  variables {
    cluster_name   = "xrproxy-test"
    region         = "us-central1"
    gcp_project_id = "my-project"
    oci_registry   = { name = "xrproxy-test" }
    system_node_pool = {
      vm_size   = "e2-standard-4"
      min_count = 2
      max_count = 4
    }
    workload_node_pool = {
      vm_size   = "e2-standard-8"
      min_count = 1
      max_count = 6
    }
    network = {
      availability_zones = ["us-central1-a", "us-central1-b"]
    }
  }

  assert {
    # node_locations must be set to the specified zones, not null.
    condition     = google_container_node_pool.system.node_locations == toset(["us-central1-a", "us-central1-b"])
    error_message = "System node pool node_locations must match network.availability_zones."
  }

  assert {
    condition     = google_container_node_pool.workload.node_locations == toset(["us-central1-a", "us-central1-b"])
    error_message = "Workload node pool node_locations must match network.availability_zones."
  }
}

# ─── Static egress (Cloud NAT) ───────────────────────────────────────────────

run "validate_static_egress" {
  command = plan

  variables {
    cluster_name   = "xrproxy-test"
    region         = "us-central1"
    gcp_project_id = "my-project"
    oci_registry   = { name = "xrproxy-test" }
    system_node_pool = {
      vm_size   = "e2-standard-4"
      min_count = 2
      max_count = 4
    }
    workload_node_pool = {
      vm_size   = "e2-standard-8"
      min_count = 1
      max_count = 6
    }
    static_egress = { enabled = true, ip_count = 2 }
  }

  assert {
    condition     = length(output.static_egress_ips) == 2
    error_message = "Expected 2 static egress IPs (ip_count = 2)."
  }
}

# ─── Private cluster — verify full cluster_access wiring ─────────────────────

run "validate_private_cluster" {
  command = plan

  variables {
    cluster_name   = "xrproxy-test"
    region         = "us-central1"
    gcp_project_id = "my-project"
    oci_registry   = { name = "xrproxy-test" }
    system_node_pool = {
      vm_size   = "e2-standard-4"
      min_count = 2
      max_count = 4
    }
    workload_node_pool = {
      vm_size   = "e2-standard-8"
      min_count = 1
      max_count = 6
    }
    cluster_access = {
      enable_private_nodes    = true
      enable_private_endpoint = false
      master_ipv4_cidr_block  = "172.16.0.32/28"
      master_authorized_networks = [
        { cidr_block = "10.0.0.0/8", display_name = "corporate" }
      ]
    }
  }

  assert {
    condition     = google_container_cluster.this.private_cluster_config[0].enable_private_nodes == true
    error_message = "cluster_access.enable_private_nodes = true must reach private_cluster_config."
  }

  assert {
    condition     = google_container_cluster.this.private_cluster_config[0].master_ipv4_cidr_block == "172.16.0.32/28"
    error_message = "master_ipv4_cidr_block was not propagated to private_cluster_config."
  }
}

# ─── Negative: prod + public endpoint + no authorized networks ────────────────
# Verifies the lifecycle precondition fires when a production cluster would
# have an unrestricted public control-plane endpoint.

run "reject_prod_open_public_endpoint" {
  command = plan

  variables {
    cluster_name   = "xrproxy-test"
    region         = "us-central1"
    gcp_project_id = "my-project"
    environment    = "prod"
    oci_registry   = { name = "xrproxy-test" }
    system_node_pool = {
      vm_size   = "e2-standard-4"
      min_count = 2
      max_count = 4
    }
    workload_node_pool = {
      vm_size   = "e2-standard-8"
      min_count = 1
      max_count = 6
    }
    # Default cluster_access: public endpoint + no authorized networks.
    # This must be rejected for environment = prod.
  }

  expect_failures = [google_container_cluster.this]
}