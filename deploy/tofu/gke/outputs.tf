# GKE outputs — implements the shared output contract from _shared/outputs.tf

output "cluster_id" {
  description = "GKE cluster resource ID."
  value       = google_container_cluster.this.id
}

output "cluster_name" {
  description = "GKE cluster name."
  value       = google_container_cluster.this.name
}

output "cluster_endpoint" {
  description = "HTTPS URL of the Kubernetes API server."
  value       = "https://${google_container_cluster.this.endpoint}"
}

output "cluster_ca_certificate" {
  description = <<-EOT
    Base64-encoded DER cluster CA certificate as returned by the google
    provider (master_auth[0].cluster_ca_certificate). This value is NOT
    double-encoded; the google provider already returns it in base64 form.
    Null when master_auth is unavailable (computed-only block, empty in mocks).
  EOT
  # Conditional (not try()) to handle the OpenTofu mock provider limitation:
  # master_auth is a computed-only block that the google provider populates
  # entirely from the API response. Mock frameworks cannot override it because
  # it is absent from the HCL configuration. In production this path is always
  # taken (master_auth is never empty for a live GKE cluster).
  value     = length(google_container_cluster.this.master_auth) > 0 ? google_container_cluster.this.master_auth[0].cluster_ca_certificate : null
  sensitive = true
}

output "kubeconfig" {
  description = "kubeconfig YAML for use with kubectl. Treat as a secret. Null when master_auth is unavailable."
  value = length(google_container_cluster.this.master_auth) > 0 ? templatefile("${path.module}/templates/kubeconfig.tftpl", {
    cluster_name     = google_container_cluster.this.name
    cluster_endpoint = google_container_cluster.this.endpoint
    cluster_ca       = google_container_cluster.this.master_auth[0].cluster_ca_certificate
    project          = var.gcp_project_id
    region           = var.region
  }) : null
  sensitive = true
}

output "oidc_issuer_url" {
  description = "OIDC issuer URL (Workload Identity Pool)."
  value       = var.workload_identity.enabled ? "https://container.googleapis.com/v1/projects/${var.gcp_project_id}/locations/${var.region}/clusters/${google_container_cluster.this.name}" : ""
}

output "workload_identity_client_id" {
  description = "Workload identity service account email for application binding."
  value       = var.workload_identity.enabled ? google_service_account.workload[0].email : ""
}

output "oci_registry_endpoint" {
  description = "Artifact Registry URL (https://region-docker.pkg.dev/project/repo)."
  value       = "https://${var.region}-docker.pkg.dev/${var.gcp_project_id}/${google_artifact_registry_repository.this.name}"
}

output "oci_registry_login_server" {
  description = "Artifact Registry login server hostname."
  value       = "${var.region}-docker.pkg.dev"
}

output "static_egress_ips" {
  description = "Reserved external IPs for Cloud NAT egress. Empty when static_egress.enabled = false."
  value       = [for addr in google_compute_address.egress : addr.address]
}

output "dns_zone_name_servers" {
  description = "Cloud DNS name servers for the managed zone. Delegate from the parent zone."
  value       = length(google_dns_managed_zone.this) > 0 ? google_dns_managed_zone.this[0].name_servers : []
}

output "observability_endpoint" {
  description = "Google Managed Prometheus query endpoint."
  value       = var.observability.enabled ? "https://monitoring.googleapis.com/v1/projects/${var.gcp_project_id}/location/global/prometheus" : ""
}

output "vpc_network_name" {
  description = "VPC network name."
  value       = google_compute_network.this.name
}