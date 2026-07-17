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
  description = "Target Kubernetes minor version (e.g. \"1.31\"). Minimum supported version is 1.25 (required for Azure CNI Overlay + Cilium dataplane)."
  type        = string
  default     = "1.31"
  validation {
    condition     = can(regex("^1\\.(2[5-9]|[3-9][0-9])$", var.kubernetes_version))
    error_message = "kubernetes_version must be a minor version string >= 1.25 (e.g. \"1.31\"). Versions 1.24 and earlier are not supported by this module."
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
  description = <<-EOT
    Network CIDR, availability zone, and dataplane configuration.

    data_plane: selects the Kubernetes network dataplane.
      "azure" (default): Azure CNI Overlay with the built-in Azure network
        policy engine. Safe for existing clusters and for new dev/staging
        environments. kube-proxy remains active.
      "cilium": eBPF-based dataplane (Cilium). kube-proxy is replaced by
        Cilium's high-performance networking stack. Cilium NetworkPolicy
        enforcement (L3-L7) is activated automatically. Requires Kubernetes
        >= 1.25 (always satisfied by this module's version validation).
        Recommended for production; a lifecycle precondition on the cluster
        resource rejects environment = prod when data_plane != "cilium".

    Migration note: AKS and AzureRM support an in-place change from "azure" to
    "cilium". Test the rollout and workload network policies in a
    non-production environment before applying it to production.
  EOT
  type = object({
    vpc_cidr           = optional(string, "10.0.0.0/16")
    node_subnet_cidr   = optional(string, "10.0.0.0/22")
    pod_cidr           = optional(string, "10.244.0.0/16")
    service_cidr       = optional(string, "10.96.0.0/16")
    dns_service_ip     = optional(string, "10.96.0.10")
    availability_zones = optional(list(string), ["1", "2", "3"])
    data_plane         = optional(string, "azure")
  })
  default = {}
  validation {
    condition     = contains(["azure", "cilium"], var.network.data_plane)
    error_message = "network.data_plane must be \"azure\" or \"cilium\"."
  }
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

variable "cluster_access" {
  description = <<-EOT
    Kubernetes API server access controls.

    private_cluster_enabled: when true, the AKS API server is accessible
    only via a private IP within the cluster VNet. The public endpoint is
    disabled. Recommended for production. Requires private DNS resolution
    (AKS creates an Azure Private DNS Zone automatically) and VPN or
    ExpressRoute for management workstation access.

    authorized_ip_ranges: CIDRs permitted to reach the PUBLIC API server
    endpoint. Only wired when private_cluster_enabled = false.
    Empty list = no restriction (acceptable for dev; BLOCKED for prod by
    lifecycle precondition — set private_cluster_enabled = true or supply
    explicit CIDRs to pass production validation).

    Both fields default to the open/public dev posture. A lifecycle
    precondition on the cluster resource rejects environment = prod when
    private_cluster_enabled = false AND authorized_ip_ranges = [].
  EOT
  type = object({
    private_cluster_enabled = optional(bool, false)
    authorized_ip_ranges    = optional(list(string), [])
  })
  default = {}
}

variable "azure_policy" {
  description = <<-EOT
    Azure Policy add-on configuration. When enabled, Azure Policy assignments
    can enforce Kubernetes admission controls cluster-wide (e.g. no privileged
    containers, required resource limits, disallowed image registries).
    Disabled by default to avoid unexpected admission rejections in development
    environments. Recommended enabled = true for production.
  EOT
  type = object({
    enabled = optional(bool, false)
  })
  default = {}
}

variable "key_vault_secrets_store" {
  description = <<-EOT
    Key Vault Secrets Store CSI driver. When enabled, pods can mount Azure
    Key Vault secrets, keys, and certificates as Kubernetes volumes without
    storing values in etcd.

    rotation_enabled: when true (default when CSI is on), the driver polls
    Key Vault at rotation_interval and updates the mounted content in-place.
    rotation_interval: polling cadence in Go duration notation (e.g. "2m",
    "30m"). "2m" is the minimum; keep it low enough for timely certificate
    rotation but avoid excessive Key Vault API calls.

    Disabled by default (enabled = false); enable when workloads consume Key
    Vault secrets. Rotation is opt-in within the CSI feature.
  EOT
  type = object({
    enabled           = optional(bool, false)
    rotation_enabled  = optional(bool, true)
    rotation_interval = optional(string, "2m")
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