# GKE module — stable shared interface variables.
# Extra variable: gcp_project_id (provider-specific; never seen by application code).

variable "cluster_name" {
  description = "Unique name for the cluster."
  type        = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,38}[a-z0-9]$", var.cluster_name))
    error_message = "cluster_name must be 3–40 lowercase alphanumeric characters or hyphens, starting and ending with a letter or digit."
  }
}

variable "environment" {
  description = "Deployment environment label (dev | staging | prod)."
  type        = string
  default     = "dev"
  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be one of: dev, staging, prod."
  }
}

variable "region" {
  description = "GCP region (e.g. \"us-central1\", \"europe-west1\")."
  type        = string
}

# Provider-specific: GCP project ID stays in the provider module;
# application code never references it.
variable "gcp_project_id" {
  description = "GCP project ID that owns all resources provisioned by this module."
  type        = string
}

variable "kubernetes_version" {
  description = "Target GKE release channel minor version (e.g. \"1.31\")."
  type        = string
  default     = "1.31"
  validation {
    condition     = can(regex("^1\\.[2-9][0-9]$", var.kubernetes_version))
    error_message = "kubernetes_version must be a minor version string such as \"1.31\"."
  }
}

variable "system_node_pool" {
  description = "System node pool configuration."
  type = object({
    vm_size   = string
    min_count = optional(number, 2)
    max_count = optional(number, 4)
  })
  default = {
    vm_size   = "e2-standard-4"
    min_count = 2
    max_count = 4
  }
}

variable "workload_node_pool" {
  description = "Workload node pool configuration."
  type = object({
    vm_size   = string
    min_count = optional(number, 1)
    max_count = optional(number, 6)
  })
  default = {
    vm_size   = "e2-standard-8"
    min_count = 1
    max_count = 6
  }
}

variable "network" {
  description = "VPC and subnet CIDR configuration."
  type = object({
    vpc_cidr           = optional(string, "10.0.0.0/16")
    node_subnet_cidr   = optional(string, "10.0.0.0/22")
    pod_cidr           = optional(string, "10.244.0.0/16")
    service_cidr       = optional(string, "10.96.0.0/16")
    dns_service_ip     = optional(string, "10.96.0.10")
    availability_zones = optional(list(string), []) # e.g. ["us-central1-a","us-central1-b","us-central1-c"]
  })
  default = {}
}

variable "oci_registry" {
  description = "Artifact Registry repository settings."
  type = object({
    name = string
    sku  = optional(string, "standard") # ignored; Artifact Registry is usage-billed
  })
}

variable "workload_identity" {
  description = "GKE Workload Identity Federation settings."
  type = object({
    enabled    = optional(bool, true)
    namespaces = optional(list(string), ["default", "flux-system"])
  })
  default = {}
}

variable "static_egress" {
  description = "Cloud NAT with reserved external IPs for predictable egress."
  type = object({
    enabled  = optional(bool, false)
    ip_count = optional(number, 1)
  })
  default = {}
}

variable "dns" {
  description = "Cloud DNS managed zone settings."
  type = object({
    enabled   = optional(bool, false)
    zone_name = optional(string, "")
  })
  default = {}
}

variable "certificates" {
  description = "TLS certificate bootstrap metadata."
  type = object({
    enabled        = optional(bool, true)
    acme_email     = optional(string, "")
    acme_server    = optional(string, "https://acme-v02.api.letsencrypt.org/directory")
    cluster_issuer = optional(string, "letsencrypt-prod")
  })
  default = {}
}

variable "observability" {
  description = "Google Cloud Managed Service for Prometheus (GMP) integration."
  type = object({
    enabled      = optional(bool, true)
    namespace    = optional(string, "monitoring")
    workspace_id = optional(string, "")
  })
  default = {}
}

variable "flux" {
  description = "Flux CD bootstrap."
  type = object({
    enabled    = optional(bool, false)
    git_url    = optional(string, "")
    git_branch = optional(string, "main")
    git_path   = optional(string, "clusters/default")
  })
  default = {}
}


variable "cluster_access" {
  description = <<-EOT
    Private cluster and control-plane access configuration.

    enable_private_nodes: when true, nodes have no public IPs. Requires NAT
    or VPC Service Controls for internet egress. Recommended for production.

    enable_private_endpoint: when true, the control plane is accessible only
    via a private IP. Requires master_authorized_networks to include the
    management CIDR.

    master_ipv4_cidr_block: RFC 1918 /28 allocated to the control plane VPC
    peering. Must not overlap with any existing subnet. Required when
    enable_private_nodes = true.

    master_authorized_networks: CIDRs that can reach the Kubernetes API.
    Restrict to corporate egress CIDRs in production. Empty list = unrestricted.
  EOT
  type = object({
    enable_private_nodes    = optional(bool, false)
    enable_private_endpoint = optional(bool, false)
    master_ipv4_cidr_block  = optional(string, "172.16.0.32/28")
    master_authorized_networks = optional(list(object({
      cidr_block   = string
      display_name = string
    })), [])
  })
  default = {}
}
variable "tags" {
  description = "Labels applied to all GCP resources."
  type        = map(string)
  default     = {}
}
