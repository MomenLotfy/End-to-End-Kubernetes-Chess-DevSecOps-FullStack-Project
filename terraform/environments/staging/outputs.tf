# Staging outputs. No credentials, passwords, or connection strings here —
# the sensitive CA output is marked sensitive; DB access flows via the
# RDS-managed Secrets Manager secret (ARN only) in Wave 5.

output "vpc_id" {
  description = "Staging VPC ID."
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
  description = "RDS-managed master secret ARN (Wave 5 ESO source)."
  value       = module.rds.master_user_secret_arn
}

output "kubeconfig_command" {
  description = "Command to configure kubectl for staging."
  value       = "aws eks update-kubeconfig --region ${var.aws_region} --name ${module.eks.cluster_name}"
}

output "eso_role_arn" {
  description = "ESO IRSA role ARN (copy into the GitOps ESO values serviceAccount annotation)."
  value       = module.iam.role_arns["eso"]
}

output "ebs_csi_role_arn" {
  description = "EBS CSI driver IRSA role ARN."
  value       = module.eks.ebs_csi_role_arn
}

output "lb_controller_role_arn" {
  description = "AWS Load Balancer Controller IRSA role ARN."
  value       = module.eks.lb_controller_role_arn
}

output "backend_role_arn" {
  description = "Wave 7: backend IRSA role ARN (copy into GitOps values: aws.backendRoleArn)."
  value       = module.iam.role_arns["backend"]
}

output "avatars_bucket_name" {
  description = "Wave 7: avatar bucket name (copy into GitOps values: avatars.bucket)."
  value       = module.s3avatars.bucket_name
}

output "redis_endpoint_address" {
  description = "Wave 7: Valkey endpoint hostname (copy into GitOps values: redis.host; TLS 6379, no credentials)."
  value       = module.elasticache.endpoint_address
}

output "redis_user_secret_arn" {
  description = "Wave 7: Valkey AUTH secret ARN (copy into GitOps values: eso.redisSecretArn)."
  value       = module.elasticache.user_secret_arn
}
