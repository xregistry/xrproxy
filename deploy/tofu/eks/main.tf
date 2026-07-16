# EKS thin module — Day-0 conservative choices
#
# Design decisions:
#   • Managed node groups: AWS handles node lifecycle, AMI updates, and
#     replacement on failure. No self-managed auto-scaling groups at Day-0.
#   • EKS add-ons (vpc-cni, coredns, kube-proxy, eks-pod-identity-agent):
#     AWS-managed lifecycle; updated independently of Kubernetes version.
#   • VPC CNI (native ENI): pod IPs are VPC-routable; no overlay; low latency.
#   • OIDC thumbprint via tls_certificate data source: fetched at plan-time
#     from the actual OIDC endpoint rather than hardcoded.
#
# ─── NAT Gateway topology ────────────────────────────────────────────────────
#
#   Production (single_az_nat = false, the default):
#     One NAT Gateway + one Elastic IP per availability zone.
#     Each node subnet has its own private route table pointing to its AZ's
#     NAT GW. An AZ failure affects only that AZ's outbound traffic; nodes
#     in other AZs continue operating normally.
#     Outputs.static_egress_ips exposes all Elastic IPs (one per AZ).
#
#   Development (single_az_nat = true, explicit opt-in):
#     One NAT Gateway + one Elastic IP total (in the first AZ).
#     All node subnets share the same private route table pointing to this
#     single NAT GW. Saves ~66% on NAT costs vs. 3-AZ default. NOT zone-
#     resilient: if the NAT GW's AZ fails, ALL nodes lose internet access.
#     A lifecycle precondition rejects single_az_nat = true for env = prod.
#
#   Disabled (static_egress.enabled = false, dev/test only):
#     Nodes are placed in public subnets with direct IGW routing.
#     Blocked for env = prod by lifecycle precondition on the cluster.
#
#   • Private ECR: images stay in account; no Docker Hub pull limits.
#   • Amazon Managed Prometheus (AMP): no operator; remote-write endpoint
#     exposed via output.
#   • Public API endpoint restricted via cluster_access.public_access_cidrs.
#   • Flux bootstrap disabled by default: enable after cluster health check.

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

# ─── VPC ────────────────────────────────────────────────────────────────────

resource "aws_vpc" "this" {
  cidr_block           = var.network.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = merge(local.common_tags, { Name = "vpc-${local.prefix}" })
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = merge(local.common_tags, { Name = "igw-${local.prefix}" })
}

resource "aws_subnet" "nodes" {
  count = length(local.azs)

  vpc_id                  = aws_vpc.this.id
  cidr_block              = cidrsubnet(var.network.node_subnet_cidr, 24 - local.node_subnet_bits, count.index)
  availability_zone       = local.azs[count.index]
  map_public_ip_on_launch = var.static_egress.enabled ? false : true
  tags = merge(local.common_tags, {
    Name                                    = "snet-nodes-${local.prefix}-${local.azs[count.index]}"
    "kubernetes.io/cluster/${local.prefix}" = "owned"
    "kubernetes.io/role/internal-elb"       = "1"
  })
}

# ─── Egress: Elastic IPs + NAT Gateways ─────────────────────────────────────

# Number of EIPs and NAT GWs = local.nat_count:
#   0 when static_egress disabled (nodes in public subnets, dev only)
#   1 when single_az_nat = true  (one shared NAT GW, dev/cost-saving, NOT prod)
#   length(azs) when single_az_nat = false (one per AZ, default/production)

resource "aws_eip" "egress" {
  count  = local.nat_count
  domain = "vpc"
  tags   = merge(local.common_tags, { Name = "eip-egress-${local.prefix}-${count.index}" })
}

resource "aws_subnet" "public" {
  count = local.nat_count

  vpc_id                  = aws_vpc.this.id
  cidr_block              = cidrsubnet(var.network.vpc_cidr, 8, 200 + count.index)
  availability_zone       = local.azs[count.index]
  map_public_ip_on_launch = true
  tags = merge(local.common_tags, {
    Name                     = "snet-public-${local.prefix}-${local.azs[count.index]}"
    "kubernetes.io/role/elb" = "1"
  })
}

resource "aws_route_table" "public" {
  count  = var.static_egress.enabled ? 1 : 0
  vpc_id = aws_vpc.this.id
  tags   = merge(local.common_tags, { Name = "rt-public-${local.prefix}" })
}

resource "aws_route" "public_igw" {
  count                  = var.static_egress.enabled ? 1 : 0
  route_table_id         = aws_route_table.public[0].id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.this.id
}

resource "aws_route_table_association" "public" {
  count          = local.nat_count
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public[0].id
}

resource "aws_nat_gateway" "this" {
  count = local.nat_count

  allocation_id = aws_eip.egress[count.index].id
  subnet_id     = aws_subnet.public[count.index].id
  tags          = merge(local.common_tags, { Name = "natgw-${local.prefix}-${count.index}" })
  depends_on    = [aws_internet_gateway.this]

  lifecycle {
    # Guard: single_az_nat routes all AZ traffic through one NAT GW.
    # An AZ failure removes internet access for ALL nodes. Not acceptable in prod.
    precondition {
      condition     = !(var.environment == "prod" && var.static_egress.single_az_nat)
      error_message = <<-EOT
        single_az_nat = true is not permitted for environment = prod. A single
        NAT Gateway is not zone-resilient: if its AZ fails, all nodes lose
        internet access. Use single_az_nat = false (the default) to get one
        NAT Gateway per availability zone.
      EOT
    }
  }
}

# Per-AZ private route tables — each node subnet gets its own table so routing
# can be tailored per-AZ without touching the other AZs.
resource "aws_route_table" "private" {
  count  = length(local.azs)
  vpc_id = aws_vpc.this.id
  tags   = merge(local.common_tags, { Name = "rt-private-${local.prefix}-${count.index}" })
}

resource "aws_route" "private_nat" {
  count = var.static_egress.enabled ? length(local.azs) : 0

  route_table_id         = aws_route_table.private[count.index].id
  destination_cidr_block = "0.0.0.0/0"
  # single_az_nat = true:  all AZs route through NAT GW[0] (cross-AZ, dev only).
  # single_az_nat = false: each AZ routes through its own NAT GW (production).
  nat_gateway_id = var.static_egress.single_az_nat ? aws_nat_gateway.this[0].id : aws_nat_gateway.this[count.index].id
}

resource "aws_route" "nodes_igw" {
  count = var.static_egress.enabled ? 0 : length(local.azs)

  route_table_id         = aws_route_table.private[count.index].id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.this.id
}

resource "aws_route_table_association" "nodes" {
  count          = length(local.azs)
  subnet_id      = aws_subnet.nodes[count.index].id
  route_table_id = aws_route_table.private[count.index].id
}

# ─── IAM: cluster role ───────────────────────────────────────────────────────

data "aws_iam_policy_document" "cluster_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["eks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "cluster" {
  name               = "role-eks-cluster-${local.prefix}"
  assume_role_policy = data.aws_iam_policy_document.cluster_assume.json
  tags               = local.common_tags
}

resource "aws_iam_role_policy_attachment" "cluster_policy" {
  role       = aws_iam_role.cluster.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AmazonEKSClusterPolicy"
}

# ─── IAM: node role ──────────────────────────────────────────────────────────

data "aws_iam_policy_document" "node_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "node" {
  name               = "role-eks-node-${local.prefix}"
  assume_role_policy = data.aws_iam_policy_document.node_assume.json
  tags               = local.common_tags
}

resource "aws_iam_role_policy_attachment" "node_worker" {
  role       = aws_iam_role.node.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AmazonEKSWorkerNodePolicy"
}

resource "aws_iam_role_policy_attachment" "node_cni" {
  role       = aws_iam_role.node.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AmazonEKS_CNI_Policy"
}

resource "aws_iam_role_policy_attachment" "node_ecr" {
  role       = aws_iam_role.node.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"
}

# ─── EKS cluster ─────────────────────────────────────────────────────────────

resource "aws_eks_cluster" "this" {
  name     = local.prefix
  version  = var.kubernetes_version
  role_arn = aws_iam_role.cluster.arn

  vpc_config {
    subnet_ids              = aws_subnet.nodes[*].id
    endpoint_private_access = var.cluster_access.private_access
    endpoint_public_access  = var.cluster_access.public_access
    public_access_cidrs     = var.cluster_access.public_access_cidrs
  }

  access_config {
    authentication_mode = "API_AND_CONFIG_MAP"
  }

  bootstrap_self_managed_addons = false

  tags       = local.common_tags
  depends_on = [aws_iam_role_policy_attachment.cluster_policy]

  lifecycle {
    precondition {
      condition     = !(var.environment == "prod" && !var.static_egress.enabled)
      error_message = "static_egress must be enabled in production. Public subnet routing (static_egress.enabled = false) exposes nodes to the internet and is not acceptable for prod."
    }
    precondition {
      # 0.0.0.0/0 allows any internet host to attempt connections to the
      # Kubernetes API server. This is unacceptable for production clusters.
      condition     = !(var.environment == "prod" && contains(var.cluster_access.public_access_cidrs, "0.0.0.0/0"))
      error_message = "public_access_cidrs cannot include 0.0.0.0/0 for environment = prod. Restrict to corporate egress CIDRs to prevent unauthenticated internet access to the Kubernetes API endpoint."
    }
  }
}

# ─── EKS add-ons ─────────────────────────────────────────────────────────────

locals {
  eks_addons = {
    "vpc-cni"                = {}
    "coredns"                = {}
    "kube-proxy"             = {}
    "eks-pod-identity-agent" = {}
  }
}

resource "aws_eks_addon" "this" {
  for_each = local.eks_addons

  cluster_name                = aws_eks_cluster.this.name
  addon_name                  = each.key
  resolve_conflicts_on_update = "OVERWRITE"
  tags                        = local.common_tags
}

# ─── OIDC provider (IRSA) ────────────────────────────────────────────────────

data "tls_certificate" "oidc" {
  count = var.workload_identity.enabled ? 1 : 0
  url   = aws_eks_cluster.this.identity[0].oidc[0].issuer
}

resource "aws_iam_openid_connect_provider" "this" {
  count = var.workload_identity.enabled ? 1 : 0

  url             = aws_eks_cluster.this.identity[0].oidc[0].issuer
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = data.tls_certificate.oidc[0].certificates[*].sha1_fingerprint
  tags            = local.common_tags
}

data "aws_iam_policy_document" "workload_assume" {
  count = var.workload_identity.enabled ? 1 : 0

  dynamic "statement" {
    for_each = var.workload_identity.namespaces
    content {
      actions = ["sts:AssumeRoleWithWebIdentity"]
      principals {
        type        = "Federated"
        identifiers = [aws_iam_openid_connect_provider.this[0].arn]
      }
      condition {
        test     = "StringLike"
        variable = "${replace(aws_eks_cluster.this.identity[0].oidc[0].issuer, "https://", "")}:sub"
        values   = ["system:serviceaccount:${statement.value}:*"]
      }
    }
  }
}

resource "aws_iam_role" "workload" {
  count              = var.workload_identity.enabled ? 1 : 0
  name               = "role-workload-${local.prefix}"
  assume_role_policy = data.aws_iam_policy_document.workload_assume[0].json
  tags               = local.common_tags
}

# ─── System managed node group ──────────────────────────────────────────────

resource "aws_eks_node_group" "system" {
  cluster_name    = aws_eks_cluster.this.name
  node_group_name = "system"
  node_role_arn   = aws_iam_role.node.arn
  subnet_ids      = aws_subnet.nodes[*].id
  instance_types  = [var.system_node_pool.vm_size]
  version         = var.kubernetes_version

  scaling_config {
    desired_size = var.system_node_pool.min_count
    min_size     = var.system_node_pool.min_count
    max_size     = var.system_node_pool.max_count
  }

  update_config {
    max_unavailable = 1
  }

  labels = { "node-role" = "system" }
  taint {
    key    = "CriticalAddonsOnly"
    value  = "true"
    effect = "NO_SCHEDULE"
  }

  tags = local.common_tags
  depends_on = [
    aws_iam_role_policy_attachment.node_worker,
    aws_iam_role_policy_attachment.node_cni,
    aws_iam_role_policy_attachment.node_ecr,
    aws_eks_addon.this,
  ]
}

# ─── Workload managed node group ────────────────────────────────────────────

resource "aws_eks_node_group" "workload" {
  cluster_name    = aws_eks_cluster.this.name
  node_group_name = "workload"
  node_role_arn   = aws_iam_role.node.arn
  subnet_ids      = aws_subnet.nodes[*].id
  instance_types  = [var.workload_node_pool.vm_size]
  version         = var.kubernetes_version

  scaling_config {
    desired_size = var.workload_node_pool.min_count
    min_size     = var.workload_node_pool.min_count
    max_size     = var.workload_node_pool.max_count
  }

  update_config {
    max_unavailable = 1
  }

  labels = { "node-role" = "workload" }
  tags   = local.common_tags
  depends_on = [
    aws_iam_role_policy_attachment.node_worker,
    aws_iam_role_policy_attachment.node_cni,
    aws_iam_role_policy_attachment.node_ecr,
  ]
}

# ─── ECR (OCI registry) ─────────────────────────────────────────────────────

resource "aws_ecr_repository" "this" {
  name                 = var.oci_registry.name
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }

  tags = local.common_tags
}

resource "aws_ecr_lifecycle_policy" "this" {
  repository = aws_ecr_repository.this.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Keep last 30 images"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = 30
        }
        action = { type = "expire" }
      }
    ]
  })
}

# ─── Route 53 DNS zone ───────────────────────────────────────────────────────

resource "aws_route53_zone" "this" {
  count = var.dns.enabled && var.dns.zone_name != "" ? 1 : 0
  name  = var.dns.zone_name
  tags  = local.common_tags
}

# ─── Amazon Managed Prometheus ───────────────────────────────────────────────

resource "aws_prometheus_workspace" "this" {
  count = var.observability.enabled ? 1 : 0
  alias = "amp-${local.prefix}"
  tags  = local.common_tags
}

# ─── Flux bootstrap ─────────────────────────────────────────────────────────

resource "flux_bootstrap_git" "this" {
  count      = local.flux_enabled ? 1 : 0
  path       = var.flux.git_path
  components = ["source-controller", "kustomize-controller", "helm-controller", "notification-controller"]
}