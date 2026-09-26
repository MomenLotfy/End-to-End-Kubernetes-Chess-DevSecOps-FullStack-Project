variable "project" {
  description = "Project slug used in resource names and tags (lowercase)."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9-]+$", var.project))
    error_message = "project must be lowercase alphanumeric with hyphens."
  }
}

variable "environment" {
  description = "Environment slug: staging or production."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9-]+$", var.environment))
    error_message = "environment must be lowercase alphanumeric with hyphens."
  }
}

variable "bucket_name" {
  description = "Explicit bucket name (default: <project>-<environment>-avatars). Globally unique; owner may override for collisions."
  type        = string
  default     = null

  validation {
    condition     = var.bucket_name == null ? true : can(regex("^[a-z0-9.-]{3,63}$", var.bucket_name))
    error_message = "bucket_name must be a valid S3 bucket name."
  }
}

variable "tags" {
  description = "Extra tags merged into every resource."
  type        = map(string)
  default     = {}
}
