# EKS module — stable shared interface variables.

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
  description = "AWS region (e.g. \"us-east-1\", \"eu-west-1\"). Passed to the AWS provider."
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
  description = "System node group configuration."
  type = object({
    vm_size   = string
    min_count = optional(number, 2)
    max_count = optional(number, 4)
  })
  default = {
    vm_size   = "m6i.large"
    min_count = 2
    max_count = 4
  }
}

variable "workload_node_pool" {
  description = "Workload node group configuration."
  type = object({
    vm_size   = string
    min_count = optional(number, 1)
    max_count = optional(number, 6)
  })
  default = {
    vm_size   = "m6i.xlarge"
    min_count = 1
    max_count = 6
  }
}

variable "network" {
  description = "VPC CIDR and availability zone configuration."
  type = object({
    vpc_cidr           = optional(string, "10.0.0.0/16")
    node_subnet_cidr   = optional(string, "10.0.0.0/22")
    pod_cidr           = optional(string, "10.244.0.0/16")
    service_cidr       = optional(string, "10.96.0.0/16")
    dns_service_ip     = optional(string, "10.96.0.10")
    availability_zones = optional(list(string), [])
  })
  default = {}
}

variable "oci_registry" {
  description = "Amazon ECR settings."
  type = object({
    name = string
    sku  = optional(string, "standard")
  })
}

variable "workload_identity" {
  description = "IRSA (IAM Roles for Service Accounts) / Pod Identity settings."
  type = object({
    enabled    = optional(bool, true)
    namespaces = optional(list(string), ["default", "flux-system"])
  })
  default = {}
}

variable "static_egress" {
  description = <<-EOT
    NAT Gateway configuration for predictable outbound egress.

    enabled = true (default): NAT Gateways with Elastic IPs are created.
    EKS nodes in private subnets require internet access to reach AWS APIs
    (ECR, EKS control plane, SSM). Disabling is dev/test only; a lifecycle
    precondition rejects enabled = false in production environments.

    single_az_nat controls NAT topology:
    - false (default): one NAT Gateway + one Elastic IP per availability zone.
      Each AZ routes through its own NAT GW. An AZ outage affects only that
      AZ's egress; all other AZs remain operational. Use for production.
    - true: one NAT Gateway + one Elastic IP total. All AZs share a single
      NAT GW. Cheaper (~66% cost reduction vs 3-AZ) but NOT zone-resilient.
      A lifecycle precondition rejects this for environment = prod.
      Use for development or cost-sensitive non-production environments.

    outputs.static_egress_ips exposes all Elastic IPs in use (1 or len(AZs)).
  EOT
  type = object({
    enabled       = optional(bool, true)
    single_az_nat = optional(bool, false)
  })
  default = { enabled = true, single_az_nat = false }
}

variable "dns" {
  description = "Route 53 hosted zone settings."
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
  description = "Amazon CloudWatch Container Insights / managed Prometheus integration."
  type = object({
    enabled      = optional(bool, true)
    namespace    = optional(string, "monitoring")
    workspace_id = optional(string, "")
  })
  default = {}
}

variable "cluster_access" {
  description = <<-EOT
    Kubernetes API server access configuration.

    public_access_cidrs restricts which IP ranges can reach the public
    endpoint. Restrict to corporate egress CIDRs in production.
    ["0.0.0.0/0"] permits anonymous internet access to the API server and
    is blocked for environment = prod via a lifecycle precondition on the
    EKS cluster resource.
  EOT
  type = object({
    public_access       = optional(bool, true)
    public_access_cidrs = optional(list(string), ["0.0.0.0/0"])
    private_access      = optional(bool, true)
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

variable "tags" {
  description = "Tags applied to all AWS resources."
  type        = map(string)
  default     = {}
}