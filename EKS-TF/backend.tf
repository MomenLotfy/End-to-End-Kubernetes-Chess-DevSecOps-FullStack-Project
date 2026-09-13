terraform {
  backend "s3" {
    bucket         = "my-devsecops-tfstate"          # ← غيّر للـ bucket الخاص بك
    region         = "us-east-1"
    key            = "chess-project/EKS-TF/terraform.tfstate"
    dynamodb_table = "terraform-lock-table"           # ← غيّر لجدول DynamoDB الخاص بك
    encrypt        = true
  }

  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"          # تحديث: كان >= 2.7.0
    }
  }
}
