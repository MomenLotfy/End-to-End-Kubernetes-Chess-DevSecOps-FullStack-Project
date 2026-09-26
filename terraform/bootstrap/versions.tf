# One-time bootstrap root: creates the encrypted state bucket (+ access-log
# bucket) with LOCAL state. Run once per AWS account BEFORE `terraform init` of
# any environment, then delete this directory's local state files (they
# reference only buckets, but hygiene matters). Owner credentials required.
# No DynamoDB table: S3 native locking (use_lockfile, Terraform >= 1.11)
# replaces the deprecated DynamoDB pattern the legacy tree used.

terraform {
  required_version = ">= 1.11.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project   = "chess"
      ManagedBy = "terraform-bootstrap"
    }
  }
}
