variable "cluster_name" {
  type    = string
  default = "xrproxy-dev"
}

variable "environment" {
  type    = string
  default = "dev"
}

variable "region" {
  type    = string
  default = "eastus"
}

variable "kubernetes_version" {
  type    = string
  default = "1.31"
}

variable "system_node_pool" {
  type = object({
    vm_size   = string
    min_count = optional(number, 2)
    max_count = optional(number, 4)
  })
  default = {
    vm_size   = "Standard_D2ds_v5"
    min_count = 2
    max_count = 4
  }
}

variable "workload_node_pool" {
  type = object({
    vm_size   = string
    min_count = optional(number, 1)
    max_count = optional(number, 6)
  })
  default = {
    vm_size   = "Standard_D4ds_v5"
    min_count = 1
    max_count = 4
  }
}

variable "network" {
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
  type = object({
    name = string
    sku  = optional(string, "standard")
  })
  default = { name = "xrproxydevacr" }
}

variable "workload_identity" {
  type = object({
    enabled    = optional(bool, true)
    namespaces = optional(list(string), ["default", "flux-system"])
  })
  default = {}
}

variable "static_egress" {
  type = object({
    enabled  = optional(bool, false)
    ip_count = optional(number, 1)
  })
  default = {}
}

variable "dns" {
  type = object({
    enabled   = optional(bool, false)
    zone_name = optional(string, "")
  })
  default = {}
}

variable "certificates" {
  type = object({
    enabled        = optional(bool, true)
    acme_email     = optional(string, "")
    acme_server    = optional(string, "https://acme-staging-v02.api.letsencrypt.org/directory")
    cluster_issuer = optional(string, "letsencrypt-staging")
  })
  default = {}
}

variable "observability" {
  type = object({
    enabled      = optional(bool, true)
    namespace    = optional(string, "monitoring")
    workspace_id = optional(string, "")
  })
  default = {}
}

variable "flux" {
  type = object({
    enabled    = optional(bool, false)
    git_url    = optional(string, "")
    git_branch = optional(string, "main")
    git_path   = optional(string, "clusters/default")
  })
  default = {}
}

variable "tags" {
  type    = map(string)
  default = { environment = "dev", team = "platform" }
}
