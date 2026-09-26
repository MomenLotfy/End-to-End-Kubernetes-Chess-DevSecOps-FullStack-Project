# Production outputs (mirror of staging; no credentials by design).

output "vpc_id" {
  description = "Production VPC ID."
  value       = module.networking.vpc_id
}

output "private_app_subnet_ids" {
  description = "Private app subnet IDs (EKS)."
  value       = module.networking.app_subnet_ids
}

output "private_data_subnet_ids" {
  description = "Private data subnet IDs (RDS)."
  value       = module.networking.data_subnet_ids
}

output "cluster_name" {
  description = "EKS cluster name."
  value       = module.eks.cluster_name
}

output "cluster_endpoint" {
  description = "Kubernetes API endpoint."
  value       = module.eks.cluster_endpoint
}

output "cluster_certificate_authority_data" {
  description = "Cluster CA data."
  value       = module.eks.cluster_certificate_authority_data
  sensitive   = true
}

output "oidc_provider_arn" {
  description = "IRSA OIDC provider ARN."
  value       = module.eks.oidc_provider_arn
}

output "node_group_name" {
  description = "Managed node group name."
  value       = module.eks.node_group_name
}

output "rds_endpoint" {
  description = "RDS hostname (no credentials)."
  value       = module.rds.endpoint
}

output "rds_master_user_secret_arn" {
  description = "RDS-managed master secret ARN."
  value       = module.rds.master_user_secret_arn
}

output "kubeconfig_command" {
  description = "Command to configure kubectl for production."
  value       = "aws eks update-kubeconfig --region ${var.aws_region} --name ${module.eks.cluster_name}"
}

# Wave 7 PLANNED (mirrors staging; no credentials by design).
output "avatars_bucket_name" {
  description = "Wave 7 planned: avatar bucket name."
  value       = module.s3avatars.bucket_name
}

output "redis_endpoint_address" {
  description = "Wave 7 planned: Valkey endpoint hostname (TLS 6379, no credentials)."
  value       = module.elasticache.endpoint_address
}

output "redis_user_secret_arn" {
  description = "Wave 7 planned: Valkey AUTH secret ARN."
  value       = module.elasticache.user_secret_arn
}
