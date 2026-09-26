# Staging environment inputs. Anything sensitive or account-specific has NO
# default and is supplied via tfvars/ENV at apply time (never committed).

variable "aws_region" {
  description = "AWS region for all staging resources."
  type        = string
  default     = "us-east-1"
}

variable "project" {
  description = "Project slug."
  type        = string
  default     = "chess"
}

variable "environment" {
  description = "Environment slug."
  type        = string
  default     = "staging"
}

variable "vpc_cidr" {
  description = "Staging VPC CIDR (must not overlap legacy 10.0.0.0/16)."
  type        = string
  default     = "10.20.0.0/16"
}

variable "cluster_admin_role_arn" {
  description = "REQUIRED: owner IAM role/user ARN granted EKS cluster-admin via access entry. No default on purpose."
  type        = string

  validation {
    condition     = can(regex("^arn:[a-z0-9-]+:iam::[0-9]{12}:(role|user)/", var.cluster_admin_role_arn))
    error_message = "cluster_admin_role_arn must be a valid IAM role/user ARN."
  }
}

variable "eks_public_access_cidrs" {
  description = "Admin CIDRs for the EKS public API endpoint. Default [] = private-only endpoint (fail closed)."
  type        = list(string)
  default     = []

  validation {
    condition     = !contains(var.eks_public_access_cidrs, "0.0.0.0/0")
    error_message = "Refusing unrestricted 0.0.0.0/0 API access: list explicit admin CIDRs."
  }
}

variable "kubernetes_version" {
  description = "EKS version (verify with `aws eks describe-cluster-versions`)."
  type        = string
  default     = "1.35"
}
