variable "aws_region" {
  description = "AWS region for the state bucket (same as environments)."
  type        = string
  default     = "us-east-1"
}

variable "state_bucket_name" {
  description = "Globally-unique S3 bucket name for Terraform state (e.g. <account>-chess-terraform-state)."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", var.state_bucket_name))
    error_message = "state_bucket_name must be a valid S3 bucket name (lowercase, 3-63 chars)."
  }
}

variable "log_retention_days" {
  description = "Retention for state-bucket access logs."
  type        = number
  default     = 90
}
