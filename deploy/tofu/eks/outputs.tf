# EKS outputs — implements the shared output contract from _shared/outputs.tf

output "cluster_id" {
  description = "EKS cluster ARN."
  value       = aws_eks_cluster.this.arn
}

output "cluster_name" {
  description = "EKS cluster name."
  value       = aws_eks_cluster.this.name
}

output "cluster_endpoint" {
  description = "HTTPS URL of the Kubernetes API server."
  value       = aws_eks_cluster.this.endpoint
}

output "cluster_ca_certificate" {
  description = "Base-64-encoded cluster CA certificate."
  value       = aws_eks_cluster.this.certificate_authority[0].data
  sensitive   = true
}

output "kubeconfig" {
  description = "kubeconfig YAML for aws eks update-kubeconfig. Treat as a secret."
  value = templatefile("${path.module}/templates/kubeconfig.tftpl", {
    cluster_name     = aws_eks_cluster.this.name
    cluster_endpoint = aws_eks_cluster.this.endpoint
    cluster_ca       = aws_eks_cluster.this.certificate_authority[0].data
    region           = var.region
  })
  sensitive = true
}

output "oidc_issuer_url" {
  description = "OIDC issuer URL for IRSA / Pod Identity."
  value       = var.workload_identity.enabled ? aws_eks_cluster.this.identity[0].oidc[0].issuer : ""
}

output "workload_identity_client_id" {
  description = "IAM Role ARN for workload identity binding via IRSA."
  value       = var.workload_identity.enabled ? aws_iam_role.workload[0].arn : ""
}

output "oci_registry_endpoint" {
  description = "ECR registry URL (https://account.dkr.ecr.region.amazonaws.com)."
  value       = "https://${aws_ecr_repository.this.repository_url}"
}

output "oci_registry_login_server" {
  description = "ECR repository URL hostname."
  value       = aws_ecr_repository.this.repository_url
}

output "static_egress_ips" {
  description = <<-EOT
    All Elastic IP addresses used for cluster egress. Empty when
    static_egress.enabled = false. Length equals:
    - length(AZs) when single_az_nat = false (one EIP per AZ, production)
    - 1             when single_az_nat = true  (one shared EIP, dev only)
    Allow-list ALL addresses in this list in external systems; the specific
    IP used for traffic from a given AZ depends on NAT Gateway routing.
  EOT
  value       = [for eip in aws_eip.egress : eip.public_ip]
}

output "dns_zone_name_servers" {
  description = "NS records for the Route 53 hosted zone. Delegate from the parent zone."
  value       = length(aws_route53_zone.this) > 0 ? aws_route53_zone.this[0].name_servers : []
}

output "observability_endpoint" {
  description = "Amazon Managed Prometheus remote-write endpoint."
  value       = var.observability.enabled ? aws_prometheus_workspace.this[0].prometheus_endpoint : ""
}

output "vpc_id" {
  description = "VPC ID."
  value       = aws_vpc.this.id
}
