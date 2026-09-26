# Wave 4 — staging root: provider + Terraform version constraints.
# - Terraform >= 1.11: S3 NATIVE state locking (use_lockfile); the legacy
#   DynamoDB lock table pattern is deprecated and is NOT used here.
# - AWS provider ~> 5.0: every pattern in this tree is written against the v5
#   schema. v6 migration is deferred until `terraform init` can run user-side
#   (USER-SIDE AWS VALIDATION REQUIRED) — no blind major upgrade.

terraform {
  required_version = ">= 1.11.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
    # Wave 7: random_password for the ElastiCache AUTH credential (the value
    # lives only in Secrets Manager + state; never in outputs or Git).
    random = {
      source  = "hashicorp/random"
      version = "~> 3.0"
    }
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = "chess"
      Environment = "staging"
      ManagedBy   = "terraform"
    }
  }
}
