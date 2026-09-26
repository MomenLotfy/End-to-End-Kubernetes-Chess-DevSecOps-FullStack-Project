# Wave 4 — RDS module: managed PostgreSQL in private data subnets, encrypted at
# rest (dedicated KMS key), TLS enforced (rds.force_ssl), master password fully
# managed by RDS in Secrets Manager (never in Terraform, state excepted for the
# secret ARN only), deletion-protected, with automated backups + PITR.
#
# No password, username secret, or connection string is output. Wave 5 wires the
# master/app credentials into ESO; Wave 4 only proves the AWS-side foundation.

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  prefix     = "${var.project}-${var.environment}"
  identifier = coalesce(var.identifier, "${local.prefix}-postgres")
}

# --- KMS: dedicated key for RDS storage + managed master-user secret. ---
# Resource "*" is REQUIRED in key policies (see eks module comment).

resource "aws_kms_key" "rds" {
  description             = "RDS encryption for ${local.identifier}"
  enable_key_rotation     = true
  deletion_window_in_days = 30

  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{
      Sid       = "EnableIamUserPolicies"
      Effect    = "Allow"
      Principal = { AWS = "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:root" }
      Action    = "kms:*"
      Resource  = "*"
    }]
  })

  tags = merge(var.tags, { Name = "${local.prefix}-rds" })
}

resource "aws_kms_alias" "rds" {
  name          = "alias/${local.prefix}-rds"
  target_key_id = aws_kms_key.rds.key_id
}

# --- Subnet group: data subnets only (no Internet route by construction). ---

resource "aws_db_subnet_group" "this" {
  name       = local.identifier
  subnet_ids = var.data_subnet_ids

  tags = merge(var.tags, { Name = "${local.identifier}-subnets" })
}

# --- Parameter group: minimal and justified — TLS enforcement only. ---

resource "aws_db_parameter_group" "this" {
  name        = "${local.prefix}-pg${split(".", var.engine_version)[0]}"
  family      = "postgres${split(".", var.engine_version)[0]}"
  description = "Wave 4: enforce TLS in transit for ${local.identifier}"

  parameter {
    name         = "rds.force_ssl"
    value        = "1"
    apply_method = "immediate"
  }

  tags = merge(var.tags, { Name = "${local.identifier}-params" })
}

# --- Security group: 5432 from the EKS cluster security group ONLY.
# Standalone rule resources (no inline blocks): exactly one ingress rule, zero
# egress rules (database initiates no connections; Terraform prunes the AWS
# default egress rule when no egress is declared). ---

resource "aws_security_group" "rds" {
  name        = "${local.prefix}-rds"
  description = "RDS PostgreSQL: 5432 from EKS cluster members only"
  vpc_id      = var.vpc_id

  tags = merge(var.tags, { Name = "${local.prefix}-rds" })
}

resource "aws_vpc_security_group_ingress_rule" "postgres_from_eks" {
  security_group_id            = aws_security_group.rds.id
  description                  = "PostgreSQL from EKS nodes/pods (EKS-managed cluster SG)"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = var.allowed_source_security_group_id
}

# --- Instance ---

resource "aws_db_instance" "this" {
  identifier = local.identifier

  engine                      = "postgres"
  engine_version              = var.engine_version
  instance_class              = var.instance_class
  db_name                     = var.db_name
  port                        = 5432
  parameter_group_name        = aws_db_parameter_group.this.name
  auto_minor_version_upgrade  = true
  allow_major_version_upgrade = false

  allocated_storage     = var.allocated_storage_gb
  max_allocated_storage = var.max_allocated_storage_gb
  storage_type          = "gp3"
  storage_encrypted     = true
  kms_key_id            = aws_kms_key.rds.arn

  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  publicly_accessible    = false
  multi_az               = var.multi_az

  # Credentials: RDS generates, stores (Secrets Manager, our KMS key) and
  # rotates the master password. Terraform never sees the value.
  master_username               = var.master_username
  manage_master_user_password   = true
  master_user_secret_kms_key_id = aws_kms_key.rds.arn

  iam_database_authentication_enabled = true

  backup_retention_period  = var.backup_retention_days
  backup_window            = var.backup_window
  maintenance_window       = var.maintenance_window
  copy_tags_to_snapshot    = true
  delete_automated_backups = true

  # Deletion protection is ON even for staging: destroying a database must be a
  # deliberate two-step (code change + apply), never an accident or an app
  # rollback side effect. See terraform/README.md rollback section.
  deletion_protection = true
  skip_final_snapshot = var.skip_final_snapshot

  performance_insights_enabled          = var.performance_insights_enabled
  performance_insights_retention_period = var.performance_insights_enabled ? var.performance_insights_retention_days : null
  performance_insights_kms_key_id       = var.performance_insights_enabled ? aws_kms_key.rds.arn : null

  monitoring_interval = var.monitoring_interval_seconds

  enabled_cloudwatch_logs_exports = ["postgresql"]

  tags = merge(var.tags, { Name = local.identifier })
}
