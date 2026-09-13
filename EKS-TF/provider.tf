provider "aws" {
  region = var.aws-region

  default_tags {
    tags = {
      Project     = "Chess-DevSecOps"
      ManagedBy   = "Terraform"
      Environment = "dev"
    }
  }
}
