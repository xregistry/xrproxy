locals {
  prefix = "${var.cluster_name}-${var.environment}"

  common_tags = merge(
    {
      "cluster"     = var.cluster_name
      "environment" = var.environment
      "managed-by"  = "opentofu"
      "module"      = "xrproxy/deploy/tofu/eks"
    },
    var.tags
  )

  # Day-0: distribute across 3 AZs; caller may override with explicit zones.
  azs = length(var.network.availability_zones) > 0 ? var.network.availability_zones : [
    "${var.region}a", "${var.region}b", "${var.region}c"
  ]

  # Derive per-AZ subnet CIDRs from the node_subnet_cidr block.
  # Splits a /22 (1024 IPs) into three /24s (256 IPs each).
  node_subnet_base = split("/", var.network.node_subnet_cidr)[0]
  node_subnet_bits = tonumber(split("/", var.network.node_subnet_cidr)[1])

  # NAT Gateway topology:
  #   single_az_nat = false (default/prod): one NAT GW + one EIP per AZ.
  #     Each node subnet routes through its own AZ's NAT GW. An AZ outage
  #     affects only that AZ's egress; other AZs are unaffected.
  #   single_az_nat = true (dev/test only): one NAT GW + one EIP total.
  #     All node subnets route through a single NAT GW. Cheaper but if that
  #     AZ fails, ALL nodes lose internet access. Blocked for env = prod.
  nat_count = !var.static_egress.enabled ? 0 : (var.static_egress.single_az_nat ? 1 : length(local.azs))

  flux_enabled = var.flux.enabled && var.flux.git_url != ""
}