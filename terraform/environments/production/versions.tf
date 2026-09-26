# Wave 4 — production root: same constraints as staging (single source of truth
# per root is intentional; roots are independent Terraform working directories).

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
    # Wave 7: random_password for the ElastiCache AUTH credential (planned
    # parity with staging; this root is still DO NOT APPLY).
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
      Environment = "production"
      ManagedBy   = "terraform"
    }
  }
}
