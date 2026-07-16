# Canonical shared input variable interface.
# Every provider module (aks, eks, gke) declares an identical set of these
# variables so callers can swap providers by changing only the module source.
# Provider-specific variable names (e.g. Azure "location", AWS "region") are
# handled inside each provider module using a local mapping.

# ─── Identity ─────────────────────────────────────────────────────────────────

variable "cluster_name" {
  description = "Unique name for the cluster. Used as a prefix for most child resources."
  type        = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,38}[a-z0-9]$", var.cluster_name))
    error_message = "cluster_name must be 3–40 lowercase alphanumeric characters or hyphens, starting and ending with a letter or digit."
  }
}

variable "environment" {
  description = "Deployment environment label (dev | staging | prod). Used in tags and resource naming."
  type        = string
  default     = "dev"
  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be one of: dev, staging, prod."
  }
}

variable "region" {
  description = <<-EOT
    Provider-neutral region identifier. Each provider module maps this to its
    own region/location/zone naming convention via a local lookup table.
    Examples: "eastus", "us-east-1", "us-central1".
  EOT
  type        = string
}

# ─── Kubernetes ───────────────────────────────────────────────────────────────

variable "kubernetes_version" {
  description = "Target Kubernetes minor version (e.g. \"1.31\"). Patch is managed by the cloud provider's auto-upgrade channel."
  type        = string
  default     = "1.31"
  validation {
    condition     = can(regex("^1\\.[2-9][0-9]$", var.kubernetes_version))
    error_message = "kubernetes_version must be a Kubernetes minor version string such as \"1.31\"."
  }
}

# ─── Capacity ─────────────────────────────────────────────────────────────────

variable "system_node_pool" {
  description = "System node pool configuration. Runs kube-system and Flux workloads."
  type = object({
    vm_size   = string # Provider-specific instance type. Passed verbatim to the cloud API.
    min_count = optional(number, 2)
    max_count = optional(number, 4)
  })
  default = {
    vm_size   = ""
    min_count = 2
    max_count = 4
  }
}

variable "workload_node_pool" {
  description = "Workload node pool configuration. Runs application pods."
  type = object({
    vm_size   = string
    min_count = optional(number, 1)
    max_count = optional(number, 6)
  })
  default = {
    vm_size   = ""
    min_count = 1
    max_count = 6
  }
}

# ─── Network ──────────────────────────────────────────────────────────────────

variable "network" {
  description = "Network CIDR and availability zone configuration."
  type = object({
    vpc_cidr           = optional(string, "10.0.0.0/16")   # Outer VPC/VNet CIDR
    node_subnet_cidr   = optional(string, "10.0.0.0/22")   # Node subnet
    pod_cidr           = optional(string, "10.244.0.0/16") # Pod overlay CIDR
    service_cidr       = optional(string, "10.96.0.0/16")  # Service CIDR
    dns_service_ip     = optional(string, "10.96.0.10")    # kube-dns ClusterIP
    availability_zones = optional(list(string), [])        # Empty = provider chooses
  })
  default = {}
}

# ─── OCI Registry ─────────────────────────────────────────────────────────────

variable "oci_registry" {
  description = "OCI container registry settings."
  type = object({
    name = string                       # Registry name/prefix. Provider modules may suffix with a unique ID.
    sku  = optional(string, "standard") # basic | standard | premium (provider-mapped)
  })
}

# ─── Workload Identity ────────────────────────────────────────────────────────

variable "workload_identity" {
  description = <<-EOT
    Workload identity federation settings. When enabled, pods can exchange a
    projected service-account token for a cloud IAM credential without static
    secrets. The provider module exposes the binding IDs via outputs.
  EOT
  type = object({
    enabled    = optional(bool, true)
    namespaces = optional(list(string), ["default", "flux-system"])
  })
  default = {}
}

# ─── Static Egress ────────────────────────────────────────────────────────────

variable "static_egress" {
  description = <<-EOT
    Predictable egress IP configuration. When enabled the module provisions a
    NAT Gateway (AKS/EKS) or Cloud NAT (GKE) with reserved static IPs so that
    outbound traffic always originates from a known address set.
  EOT
  type = object({
    enabled  = optional(bool, false)
    ip_count = optional(number, 1)
  })
  default = {}
}

# ─── DNS ──────────────────────────────────────────────────────────────────────

variable "dns" {
  description = "DNS zone managed by the cloud provider."
  type = object({
    enabled   = optional(bool, false)
    zone_name = optional(string, "") # e.g. "xrproxy.example.com"
  })
  default = {}
}

# ─── TLS / Certificates ───────────────────────────────────────────────────────

variable "certificates" {
  description = <<-EOT
    TLS certificate bootstrap settings. cert-manager is installed via Flux;
    these values are written to a ConfigMap so the Flux HelmRelease can read
    them without embedding provider-specific data in the application chart.
  EOT
  type = object({
    enabled        = optional(bool, true)
    acme_email     = optional(string, "")
    acme_server    = optional(string, "https://acme-v02.api.letsencrypt.org/directory")
    cluster_issuer = optional(string, "letsencrypt-prod")
  })
  default = {}
}

# ─── Observability ────────────────────────────────────────────────────────────

variable "observability" {
  description = <<-EOT
    Observability integration. When enabled the module wires the cluster to the
    provider's managed metrics and log collection service. The endpoint is
    exposed via output so application charts can configure remote-write/export
    without knowing the provider API.
  EOT
  type = object({
    enabled      = optional(bool, true)
    namespace    = optional(string, "monitoring")
    workspace_id = optional(string, "") # Pre-existing workspace/project ID (optional)
  })
  default = {}
}

# ─── Flux Bootstrap ───────────────────────────────────────────────────────────

variable "flux" {
  description = <<-EOT
    Flux CD bootstrap configuration. When enabled, Flux is bootstrapped into
    the cluster against the specified Git repository path. Requires a valid
    git_url and the flux provider to be configured with appropriate credentials.
    Safe to leave disabled for Day-0 provisioning; enable in a second apply.
  EOT
  type = object({
    enabled    = optional(bool, false)
    git_url    = optional(string, "") # SSH or HTTPS URL
    git_branch = optional(string, "main")
    git_path   = optional(string, "clusters/default")
  })
  default = {}
}

# ─── Tags / Labels ────────────────────────────────────────────────────────────

variable "tags" {
  description = "Map of tags/labels applied to all cloud resources created by this module."
  type        = map(string)
  default     = {}
}
