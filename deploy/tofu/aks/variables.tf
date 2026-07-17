# AKS module — stable shared interface variables.

variable "cluster_name" {
  description = "Unique name for the cluster. Used as a prefix for most child resources."
  type        = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,38}[a-z0-9]$", var.cluster_name))
    error_message = "cluster_name must be 3-40 lowercase alphanumeric characters or hyphens, starting and ending with a letter or digit."
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
  description = "Azure region (e.g. \"eastus\", \"westeurope\"). Passed directly to azurerm as location."
  type        = string
}

variable "kubernetes_version" {
  description = "Target Kubernetes minor version (e.g. \"1.31\")."
  type        = string
  default     = "1.31"
  validation {
    condition     = can(regex("^1\\.[2-9][0-9]$", var.kubernetes_version))
    error_message = "kubernetes_version must be a minor version string such as \"1.31\"."
  }
}

variable "system_node_pool" {
  description = <<-EOT
    System node pool configuration. Runs kube-system and Flux workloads.
    min_count must be >= the number of availability zones to guarantee at least
    one system node per zone (enforced by a lifecycle precondition on the cluster).
    The default of 3 matches the default 3-zone deployment.
  EOT
  type = object({
    vm_size   = string
    min_count = optional(number, 3) # One per default AZ; adjust if zones differ
    max_count = optional(number, 6)
  })
  default = {
    vm_size   = "Standard_D2ds_v5"
    min_count = 3
    max_count = 6
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
    vm_size   = "Standard_D4ds_v5"
    min_count = 1
    max_count = 6
  }
}

variable "network" {
  description = "Network CIDR and availability zone configuration."
  type = object({
    vpc_cidr           = optional(string, "10.0.0.0/16")
    node_subnet_cidr   = optional(string, "10.0.0.0/22")
    pod_cidr           = optional(string, "10.244.0.0/16")
    service_cidr       = optional(string, "10.96.0.0/16")
    dns_service_ip     = optional(string, "10.96.0.10")
    availability_zones = optional(list(string), ["1", "2", "3"])
  })
  default = {}
}

variable "oci_registry" {
  description = "Azure Container Registry settings."
  type = object({
    name = string
    sku  = optional(string, "standard")
  })
}

variable "workload_identity" {
  description = "Workload identity (Entra Workload ID) settings."
  type = object({
    enabled    = optional(bool, true)
    namespaces = optional(list(string), ["default", "flux-system"])
  })
  default = {}
}

variable "static_egress" {
  description = <<-EOT
    NAT Gateway configuration for predictable outbound egress.

    nat_sku controls the NAT Gateway (and matching Public IP) SKU:

    "StandardV2" (default): zone-redundant. A single StandardV2 gateway
    serves all availability zones automatically with no zone pinning.
    Requires a region that supports Availability Zones. If the region does
    not support AZs, the Azure API returns an explicit error at tofu apply
    time — there is no silent fallback.
    Reference: https://learn.microsoft.com/azure/reliability/reliability-nat-gateway

    "Standard": Standard v1, zonal. Without an explicit zone pin the gateway
    is nonzonal (Azure picks the zone at random), which the Azure reliability
    docs explicitly advise against for production. A lifecycle precondition
    rejects Standard v1 when more than one availability zone is configured to
    prevent a false sense of zone-HA from a single zonal gateway.

    StandardV2 NAT Gateway requires StandardV2 public IP addresses. Standard
    public IPs are incompatible with StandardV2 NAT Gateway. This module
    always uses nat_sku for both the NAT Gateway and the public IP SKU so
    they always match.
  EOT
  type = object({
    enabled  = optional(bool, false)
    ip_count = optional(number, 1)
    nat_sku  = optional(string, "StandardV2")
  })
  default = {}
  validation {
    condition     = contains(["Standard", "StandardV2"], var.static_egress.nat_sku)
    error_message = "static_egress.nat_sku must be \"Standard\" or \"StandardV2\". StandardV2 is recommended for production."
  }
}

variable "dns" {
  description = "Azure DNS zone settings."
  type = object({
    enabled   = optional(bool, false)
    zone_name = optional(string, "")
  })
  default = {}
}

variable "certificates" {
  description = "TLS certificate bootstrap metadata written to a ConfigMap for Flux/cert-manager."
  type = object({
    enabled        = optional(bool, true)
    acme_email     = optional(string, "")
    acme_server    = optional(string, "https://acme-v02.api.letsencrypt.org/directory")
    cluster_issuer = optional(string, "letsencrypt-prod")
  })
  default = {}
}

variable "observability" {
  description = "Azure Monitor managed Prometheus / Container Insights integration."
  type = object({
    enabled      = optional(bool, true)
    namespace    = optional(string, "monitoring")
    workspace_id = optional(string, "")
  })
  default = {}
}

variable "flux" {
  description = "Flux CD bootstrap. Set enabled = true only after cluster is healthy."
  type = object({
    enabled    = optional(bool, false)
    git_url    = optional(string, "")
    git_branch = optional(string, "main")
    git_path   = optional(string, "clusters/default")
  })
  default = {}
}

variable "tags" {
  description = "Tags applied to all Azure resources."
  type        = map(string)
  default     = {}
}