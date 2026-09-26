# Wave 4 — staging: 2 AZs, single NAT, single-AZ RDS, 7-day backups.
# Staging proves the foundation cheaply; production overrides the same variables
# (see ../production) — no copy/paste divergence.

module "networking" {
  source = "../../modules/networking"

  project     = var.project
  environment = var.environment
  vpc_cidr    = var.vpc_cidr

  az_count           = 2
  single_nat_gateway = true # staging cost decision; production uses per-AZ NAT

  cluster_name = "${var.project}-${var.environment}-eks"

  enable_flow_logs = true
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
  node_desired_size   = 2
  node_min_size       = 1
  node_max_size       = 3

  # Wave 5 platform add-ons (uploads PVC + ALB Ingress), each with a dedicated
  # IRSA role owned by the eks module (no cross-module cycle by construction).
  # Wave 6 adds metrics-server (resource metrics; no IRSA — see eks module).
  enable_ebs_csi         = true
  enable_lb_controller   = true
  enable_metrics_server  = true
}

module "rds" {
  source = "../../modules/rds"

  project     = var.project
  environment = var.environment

  instance_class = "db.t4g.micro"
  multi_az       = false # staging: single-AZ; production: true

  backup_retention_days = 7
  skip_final_snapshot   = true # staging data is disposable; prod keeps final snapshots

  vpc_id                           = module.networking.vpc_id
  data_subnet_ids                  = module.networking.data_subnet_ids
  allowed_source_security_group_id = module.eks.cluster_security_group_id
}

# Wave 7: private avatar object store. The pod reaches it ONLY through the
# backend IRSA role below (three object actions, avatars/* prefix).
module "s3avatars" {
  source = "../../modules/s3avatars"

  project     = var.project
  environment = var.environment
}

# Wave 7: private ephemeral coordination cache (socket fan-out, rate limits,
# rematch votes). Serverless Valkey in the data tier; 6379 from the EKS
# cluster SG only; AUTH credential in its own SM secret (ESO chess-redis).
module "elasticache" {
  source = "../../modules/elasticache"

  project     = var.project
  environment = var.environment

  vpc_id                           = module.networking.vpc_id
  data_subnet_ids                  = module.networking.data_subnet_ids
  allowed_source_security_group_id = module.eks.cluster_security_group_id
}

# Wave 5: IRSA factory carries the External Secrets Operator role.
# Wave 7 DELTA: the backend pod gains ONE narrow AWS permission (avatar
# objects via the backend role). Everything else still flows through
# ESO-synced Secrets, so a compromised pod still cannot reach Secrets
# Manager — and it cannot list, share, or make public any S3 object.
module "iam" {
  source = "../../modules/iam"

  project     = var.project
  environment = var.environment

  cluster_name      = module.eks.cluster_name
  oidc_provider_arn = module.eks.oidc_provider_arn
  oidc_provider_url = module.eks.oidc_issuer_url

  roles = {
    eso = {
      namespace           = "external-secrets"
      service_account     = "external-secrets"
      description         = "Wave 5/6/7: ESO reads exactly four staging secrets (RDS master + app + observability + redis)"
      policy_statements   = [{
        Sid    = "ReadChessStagingSecrets"
        Effect = "Allow"
        Action = [
          "secretsmanager:GetSecretValue",
          "secretsmanager:DescribeSecret",
        ]
        Resource = [
          module.rds.master_user_secret_arn,
          # Wave 7: Valkey AUTH secret (TF-created; ESO chess-redis source).
          module.elasticache.user_secret_arn,
          # Trailing * is AWS-mandated: secret ARNs carry a random 6-char
          # suffix. Scope stays one named secret (owner creates
          # chess/staging/app per the Wave 5 runbook BEFORE first sync).
          "arn:${data.aws_partition.current.partition}:secretsmanager:${var.aws_region}:${data.aws_caller_identity.current.account_id}:secret:chess/staging/app*",
          # Wave 6: grafana admin + alert webhook (owner creates
          # chess/staging/observability per the Wave 6 runbook).
          "arn:${data.aws_partition.current.partition}:secretsmanager:${var.aws_region}:${data.aws_caller_identity.current.account_id}:secret:chess/staging/observability*",
        ]
      }]
    }
    # Wave 7: backend avatar access. No ListBucket (keys are addressed
    # directly), no bucket-level actions, no other bucket. Trust is bound to
    # the chess-backend ServiceAccount in THIS namespace only (see iam module).
    backend = {
      namespace           = "chess-staging"
      service_account     = "chess-backend"
      description         = "Wave 7: backend avatar objects ONLY (IRSA; no static credentials)"
      policy_statements   = [{
        Sid    = "AvatarObjectsOnly"
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject",
        ]
        Resource = [
          "${module.s3avatars.bucket_arn}/avatars/*",
        ]
      }]
    }
  }
}

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
