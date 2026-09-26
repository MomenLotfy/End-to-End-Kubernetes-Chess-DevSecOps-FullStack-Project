# Wave 7 — elasticache module: private ephemeral coordination cache.
#
# ARCHITECTURE DECISION (serverless Valkey, documented once, here):
# - ElastiCache Serverless, engine valkey: zero node sizing (staging-ideal),
#   VPC-only endpoint, TLS enforced, AUTH via ElastiCache users.
# - Valkey over Redis OSS for ONE reason: the serverless storage floor is
#   100 MB (~$6/mo) instead of 1 GB (~$91/mo). The workload is kilobytes of
#   ephemeral coordination (socket fan-out, rate counters, rematch votes), so
#   the Redis floor would be 15x overpayment for idle capacity. Protocol and
#   client compatibility (ioredis, socket.io adapter) are identical for the
#   commands Wave 7 uses (strings, sets, pub/sub, TTL — no modules, no Lua
#   beyond adapter-internal EVAL, which Valkey supports).
# - major_engine_version 8 (variable; changing it REPLACES the cache — safe
#   because the cache holds no authoritative state, only recreatable
#   ephemeral coordination).
#
# WHAT THIS CACHE IS (and is not): ephemeral coordination ONLY. Socket.io
# pub/sub fan-out, fixed-window rate counters, rematch vote sets. Chess/game
# truth stays in PostgreSQL; NOTHING here is backed up for recovery
# (snapshot_retention_limit = 1 day is crash-convenience, not a DR story —
# restores of stale rate/vote state would be actively wrong and are never
# part of any runbook).
#
# Security posture (asserted by scripts/wave7-static-checks.py):
# - Data subnets (same private tier as RDS), dedicated SG, ONE ingress rule:
#   tcp/6379 from the EKS cluster SG only. No 0.0.0.0/0 ingress.
# - AUTH password: random 48-char alphanumeric, stored ONLY in the dedicated
#   Secrets Manager secret (chess/<env>/redis); app delivery is ESO (Wave 5
#   pattern). No password in outputs, values, or state beyond the secret ARN.
# - Least-privilege user: single-purpose cache, ACL `on ~* allchannels
#   +@all -@dangerous` (FLUSH/CONFIG/DEBUG-class commands denied; every Wave 7
#   command — strings/sets/pubsub/TTL/EVAL — is outside @dangerous).
# - Cost guardrails: cache_usage_limits cap storage at 1 GB and compute at
#   5000 ECPU/s (throttle, not surprise bill — see cost note in the baseline).
#
# Deletion behavior: the cache is disposable by design (ephemeral). No
# final-snapshot requirement; the SM secret keeps a 30-day recovery window so
# a mistaken destroy does not strand the ESO contract irrecoverably.

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.0"
    }
  }
}

locals {
  prefix     = "${var.project}-${var.environment}"
  cache_name = coalesce(var.cache_name, "${local.prefix}-redis")
}

# --- Security boundary: 6379 from EKS members only (RDS pattern). ---
# No egress rules (the cache initiates no connections; Terraform prunes the
# AWS default egress rule when no egress is declared).

resource "aws_security_group" "redis" {
  name        = "${local.prefix}-redis"
  description = "ElastiCache Valkey: 6379 from EKS cluster members only"
  vpc_id      = var.vpc_id

  tags = merge(var.tags, { Name = "${local.prefix}-redis" })
}

resource "aws_vpc_security_group_ingress_rule" "redis_from_eks" {
  security_group_id            = aws_security_group.redis.id
  description                  = "Redis from EKS nodes/pods (EKS-managed cluster SG)"
  ip_protocol                  = "tcp"
  from_port                    = 6379
  to_port                      = 6379
  referenced_security_group_id = var.allowed_source_security_group_id
}

# --- AUTH credential: generated, Secrets-Manager-held, never output. ---

resource "random_password" "auth" {
  length  = 48
  special = false # alphanumeric only: valid in every Redis AUTH context
}

resource "aws_secretsmanager_secret" "redis" {
  name                    = "${var.project}/${var.environment}/redis"
  description             = "Wave 7: ElastiCache Valkey AUTH for ${local.prefix} (ESO chess-redis source)"
  recovery_window_in_days = var.secret_recovery_window_days

  tags = merge(var.tags, { Name = "${local.prefix}-redis" })
}

resource "aws_secretsmanager_secret_version" "redis" {
  secret_id     = aws_secretsmanager_secret.redis.id
  secret_string = jsonencode({
    username = var.redis_username
    password = random_password.auth.result
  })
}

# --- Valkey users: one least-privilege app user in a dedicated group. ---

resource "aws_elasticache_user" "app" {
  engine        = "valkey"
  user_id       = "${local.prefix}-app"
  user_name     = var.redis_username
  access_string = "on ~* allchannels +@all -@dangerous"
  passwords     = [random_password.auth.result]

  tags = merge(var.tags, { Name = "${local.prefix}-app" })
}

resource "aws_elasticache_user_group" "this" {
  engine        = "valkey"
  user_group_id = "${local.prefix}-app"
  user_ids      = [aws_elasticache_user.app.user_id]

  tags = merge(var.tags, { Name = "${local.prefix}-app" })
}

# --- Serverless cache: private data subnets, TLS, capped spend. ---
# In-transit encryption is mandatory on serverless (no insecure mode exists);
# at-rest uses the AWS-managed key (CMK binding is a Wave 8 hardening).

resource "aws_elasticache_serverless_cache" "this" {
  name                 = local.cache_name
  description          = "Wave 7 ephemeral coordination for ${local.prefix} (socket fan-out, rate limits, rematch votes)"
  engine               = "valkey"
  major_engine_version = var.engine_version

  subnet_ids         = var.data_subnet_ids
  security_group_ids = [aws_security_group.redis.id]
  user_group_id      = aws_elasticache_user_group.this.id

  daily_snapshot_time      = var.daily_snapshot_time
  snapshot_retention_limit = var.snapshot_retention_limit

  cache_usage_limits {
    data_storage {
      maximum = var.max_data_storage_gb
      unit    = "GB"
    }
    ecpu_per_seconds {
      maximum = var.max_ecpu_per_second
    }
  }

  tags = merge(var.tags, { Name = local.cache_name })
}
