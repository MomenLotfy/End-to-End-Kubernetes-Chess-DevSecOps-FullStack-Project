# Wave 4 — production: PLANNED VALUES ONLY. DO NOT `terraform apply` this root
# in Wave 4: there is no production cutover, no GitOps promotion path, and no
# DR story yet (Waves 5-8). This root exists to prove the modules reach
# production-grade posture (3 AZs, per-AZ NAT, Multi-AZ RDS, 30-day backups)
# through variables alone.

module "networking" {
  source = "../../modules/networking"

  project     = var.project
  environment = var.environment
  vpc_cidr    = var.vpc_cidr

  az_count           = 3
  single_nat_gateway = false # production resilience: one NAT per AZ

  cluster_name = "${var.project}-${var.environment}-eks"

  enable_flow_logs        = true
  flow_log_retention_days = 90
}

module "eks" {
  source = "../../modules/eks"

  project     = var.project
  environment = var.environment

  kubernetes_version = var.kubernetes_version

  vpc_id         = module.networking.vpc_id
  app_subnet_ids = module.networking.app_subnet_ids

  admin_role_arn      = var.cluster_admin_role_arn
  public_access_cidrs = var.eks_public_access_cidrs

  node_instance_types = ["t3.medium"]
  node_desired_size   = 3
  node_min_size       = 2
  node_max_size       = 6

  log_retention_days = 90

  # Planned parity with staging (still DO NOT APPLY in Wave 5).
  enable_ebs_csi         = true
  enable_lb_controller   = true
  enable_metrics_server  = true
}

module "rds" {
  source = "../../modules/rds"

  project     = var.project
  environment = var.environment

  instance_class = "db.t4g.small"
  multi_az       = true

  backup_retention_days = 30
  skip_final_snapshot   = false # production always keeps a final snapshot

  vpc_id                           = module.networking.vpc_id
  data_subnet_ids                  = module.networking.data_subnet_ids
  allowed_source_security_group_id = module.eks.cluster_security_group_id
}

# Wave 7 PLANNED (not applied): avatar bucket. Serverless needs no sizing, so
# the only production delta is the environment slug (bucket name/ARN).
module "s3avatars" {
  source = "../../modules/s3avatars"

  project     = var.project
  environment = var.environment
}

# Wave 7 PLANNED (not applied): ephemeral coordination cache. Same serverless
# Valkey shape as staging; production cost ceilings (usage limits) and the
# snapshot policy are re-decided with observed traffic in Wave 8.
module "elasticache" {
  source = "../../modules/elasticache"

  project     = var.project
  environment = var.environment

  vpc_id                           = module.networking.vpc_id
  data_subnet_ids                  = module.networking.data_subnet_ids
  allowed_source_security_group_id = module.eks.cluster_security_group_id
}

module "iam" {
  source = "../../modules/iam"

  project     = var.project
  environment = var.environment

  cluster_name      = module.eks.cluster_name
  oidc_provider_arn = module.eks.oidc_provider_arn
  oidc_provider_url = module.eks.oidc_issuer_url

  # Wave 7: still empty on purpose — no production secrets exist yet, so no
  # ESO/backend IRSA roles are granted. Wave 8 cutover populates this map.
  roles = {}
}
