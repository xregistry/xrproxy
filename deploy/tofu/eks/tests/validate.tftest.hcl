# EKS module static-plan test with mock providers.
# Run with: tofu test
# No AWS credentials are required — mock_provider intercepts all API calls.
#
# NAT topology tests:
#   validate_minimal        — 3-AZ default: one NAT GW + EIP per AZ (production)
#   validate_single_az_nat  — 1 NAT GW total (dev cost-saving, env = dev)
#   validate_static_egress  — explicit 3-AZ config with restricted API access

mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "123456789012"
      arn        = "arn:aws:iam::123456789012:root"
      user_id    = "AIDAIOSFODNN7EXAMPLE"
    }
  }
  mock_data "aws_partition" {
    defaults = {
      partition  = "aws"
      dns_suffix = "amazonaws.com"
    }
  }
  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }
  mock_resource "aws_vpc" {
    defaults = {
      id  = "vpc-0123456789abcdef0"
      arn = "arn:aws:ec2:us-east-1:123456789012:vpc/vpc-0123456789abcdef0"
    }
  }
  mock_resource "aws_eks_cluster" {
    defaults = {
      id       = "xrproxy-test-dev"
      arn      = "arn:aws:eks:us-east-1:123456789012:cluster/xrproxy-test-dev"
      endpoint = "https://ABCDEF1234567890.gr7.us-east-1.eks.amazonaws.com"
      certificate_authority = [{
        data = "dGVzdC1jYQ=="
      }]
      identity = [{
        oidc = [{
          issuer = "https://oidc.eks.us-east-1.amazonaws.com/id/ABCDEF1234567890"
        }]
      }]
    }
  }
  mock_resource "aws_ecr_repository" {
    defaults = {
      id             = "xrproxy-test"
      arn            = "arn:aws:ecr:us-east-1:123456789012:repository/xrproxy-test"
      repository_url = "123456789012.dkr.ecr.us-east-1.amazonaws.com/xrproxy-test"
    }
  }
  mock_resource "aws_iam_role" {
    defaults = {
      id  = "role-workload-xrproxy-test-dev"
      arn = "arn:aws:iam::123456789012:role/role-workload-xrproxy-test-dev"
    }
  }
  mock_resource "aws_iam_openid_connect_provider" {
    defaults = {
      id  = "arn:aws:iam::123456789012:oidc-provider/oidc.eks.us-east-1.amazonaws.com/id/ABCDEF1234567890"
      arn = "arn:aws:iam::123456789012:oidc-provider/oidc.eks.us-east-1.amazonaws.com/id/ABCDEF1234567890"
    }
  }
  mock_resource "aws_prometheus_workspace" {
    defaults = {
      id                  = "ws-00000000-0000-0000-0000-000000000000"
      arn                 = "arn:aws:aps:us-east-1:123456789012:workspace/ws-00000000-0000-0000-0000-000000000000"
      prometheus_endpoint = "https://aps-workspaces.us-east-1.amazonaws.com/workspaces/ws-00000000-0000-0000-0000-000000000000/"
    }
  }
  mock_resource "aws_eip" {
    defaults = {
      id        = "eipalloc-00000000000000000"
      public_ip = "52.1.2.3"
    }
  }
  mock_resource "aws_nat_gateway" {
    defaults = {
      id = "nat-00000000000000000"
    }
  }
}

mock_provider "tls" {
  mock_data "tls_certificate" {
    defaults = {
      certificates = [{
        sha1_fingerprint = "9e99a48a9960b14926bb7f3b02e22da2b0ab7280"
        is_ca            = true
        serial_number    = "0"
        subject          = "CN=Amazon Root CA 1"
      }]
    }
  }
}

mock_provider "flux" {}

# ─── Production default: one NAT GW + EIP per AZ (3 AZs = 3 IPs) ───────────

run "validate_minimal" {
  command = plan

  variables {
    cluster_name = "xrproxy-test"
    region       = "us-east-1"
    oci_registry = { name = "xrproxy-test" }
    system_node_pool = {
      vm_size   = "m6i.large"
      min_count = 2
      max_count = 4
    }
    workload_node_pool = {
      vm_size   = "m6i.xlarge"
      min_count = 1
      max_count = 6
    }
    # Default: static_egress.enabled = true, single_az_nat = false (prod)
    cluster_access = { public_access_cidrs = ["10.0.0.0/8"] }
  }

  assert {
    condition     = output.cluster_name == "xrproxy-test-dev"
    error_message = "Expected cluster_name to follow {cluster_name}-{environment} pattern."
  }

  # One NAT GW per AZ: 3 AZs → 3 Elastic IPs in static_egress_ips.
  assert {
    condition     = length(output.static_egress_ips) == 3
    error_message = "Expected one EIP per AZ (3 total) for production multi-AZ NAT topology."
  }
}

# ─── Dev/cost-saving: single NAT GW (not AZ-resilient, nonprod only) ─────────

run "validate_single_az_nat" {
  command = plan

  variables {
    cluster_name = "xrproxy-test"
    region       = "us-east-1"
    oci_registry = { name = "xrproxy-test" }
    system_node_pool = {
      vm_size   = "m6i.large"
      min_count = 2
      max_count = 4
    }
    workload_node_pool = {
      vm_size   = "m6i.xlarge"
      min_count = 1
      max_count = 6
    }
    # Dev only: single NAT GW (cross-AZ egress, not zone-resilient).
    # The precondition blocks this for environment = prod.
    environment = "dev"
    static_egress = {
      enabled       = true
      single_az_nat = true
    }
    cluster_access = { public_access_cidrs = ["0.0.0.0/0"] }
  }

  # Single NAT GW: 1 EIP regardless of AZ count.
  assert {
    condition     = length(output.static_egress_ips) == 1
    error_message = "Expected exactly 1 EIP when single_az_nat = true."
  }
}

# ─── Explicit 3-AZ production topology with restricted API access ─────────────

run "validate_static_egress" {
  command = plan

  variables {
    cluster_name = "xrproxy-test"
    region       = "us-east-1"
    oci_registry = { name = "xrproxy-test" }
    system_node_pool = {
      vm_size   = "m6i.large"
      min_count = 2
      max_count = 4
    }
    workload_node_pool = {
      vm_size   = "m6i.xlarge"
      min_count = 1
      max_count = 6
    }
    static_egress  = { enabled = true, single_az_nat = false }
    cluster_access = { public_access_cidrs = ["203.0.113.0/24"] }
  }

  assert {
    condition     = length(output.static_egress_ips) == 3
    error_message = "Expected 3 EIPs (one per AZ) for multi-AZ NAT topology."
  }
}
# ─── Negative: 0.0.0.0/0 rejected in prod ───────────────────────────────────
# Verifies the lifecycle precondition fires when public_access_cidrs includes
# the open CIDR in a production environment.

run "reject_open_cidr_in_prod" {
  command = plan

  variables {
    cluster_name = "xrproxy-test"
    region       = "us-east-1"
    environment  = "prod"
    oci_registry = { name = "xrproxy-test" }
    system_node_pool = {
      vm_size   = "m6i.large"
      min_count = 2
      max_count = 4
    }
    workload_node_pool = {
      vm_size   = "m6i.xlarge"
      min_count = 1
      max_count = 6
    }
    static_egress = { enabled = true, single_az_nat = false }
    # 0.0.0.0/0 in prod must be rejected by lifecycle precondition.
    cluster_access = {
      public_access_cidrs = ["0.0.0.0/0"]
    }
  }

  # Expect the cluster resource's precondition to fail.
  expect_failures = [aws_eks_cluster.this]
}