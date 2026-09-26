output "cluster_name" {
  description = "EKS cluster name."
  value       = aws_eks_cluster.this.name
}

output "cluster_endpoint" {
  description = "Kubernetes API endpoint."
  value       = aws_eks_cluster.this.endpoint
}

output "cluster_certificate_authority_data" {
  description = "Base64 cluster CA data."
  value       = aws_eks_cluster.this.certificate_authority[0].data
  sensitive   = true
}

output "cluster_security_group_id" {
  description = "EKS-managed cluster security group ID (attached to nodes and control-plane ENIs; sole RDS ingress source)."
  value       = aws_eks_cluster.this.vpc_config[0].cluster_security_group_id
}

output "oidc_provider_arn" {
  description = "IAM OIDC provider ARN for IRSA."
  value       = aws_iam_openid_connect_provider.this.arn
}

output "oidc_issuer_url" {
  description = "OIDC issuer URL for IRSA trust policies."
  value       = aws_eks_cluster.this.identity[0].oidc[0].issuer
}

output "node_role_arn" {
  description = "Worker-node IAM role ARN."
  value       = aws_iam_role.nodes.arn
}

output "node_group_name" {
  description = "Managed node group name."
  value       = aws_eks_node_group.this.node_group_name
}

output "kms_key_arn" {
  description = "Envelope-encryption KMS key ARN."
  value       = aws_kms_key.eks_secrets.arn
}

output "ebs_csi_role_arn" {
  description = "EBS CSI driver IRSA role ARN (null when the add-on is disabled)."
  value       = var.enable_ebs_csi ? aws_iam_role.ebs_csi[0].arn : null
}

output "lb_controller_role_arn" {
  description = "AWS Load Balancer Controller IRSA role ARN (null when the add-on is disabled)."
  value       = var.enable_lb_controller ? aws_iam_role.lb_controller[0].arn : null
}
