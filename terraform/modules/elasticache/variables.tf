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

variable "cache_name" {
  description = "Serverless cache name (default: <project>-<environment>-redis)."
  type        = string
  default     = null
}

variable "engine_version" {
  description = "Valkey major engine version. Changing it REPLACES the cache (safe: ephemeral only)."
  type        = string
  default     = "8"

  validation {
    condition     = can(regex("^(7|8)$", var.engine_version))
    error_message = "engine_version must be a supported Valkey major (7 or 8)."
  }
}

variable "vpc_id" {
  description = "VPC ID for the dedicated Redis security group."
  type        = string
}

variable "data_subnet_ids" {
  description = "Private data-tier subnet IDs for the cache endpoint (same tier as RDS; never public)."
  type        = list(string)

  validation {
    condition     = length(var.data_subnet_ids) >= 2
    error_message = "data_subnet_ids needs at least two AZs."
  }
}

variable "allowed_source_security_group_id" {
  description = "The ONLY 6379 ingress source (EKS cluster SG)."
  type        = string
}

variable "redis_username" {
  description = "Valkey AUTH username (also stored in the Secrets Manager JSON)."
  type        = string
  default     = "chess-app"
}

variable "max_data_storage_gb" {
  description = "Serverless storage ceiling in GB (throttle, not bill, beyond this)."
  type        = number
  default     = 1
}

variable "max_ecpu_per_second" {
  description = "Serverless compute ceiling in ECPU/s (throttle, not bill, beyond this)."
  type        = number
  default     = 5000
}

variable "daily_snapshot_time" {
  description = "Daily snapshot window (UTC, HH:MM)."
  type        = string
  default     = "03:00"
}

variable "snapshot_retention_limit" {
  description = "Snapshot retention in days (crash-convenience only; the cache is ephemeral by design)."
  type        = number
  default     = 1
}

variable "secret_recovery_window_days" {
  description = "Secrets Manager recovery window (0 = force delete; staging keeps 30)."
  type        = number
  default     = 30

  validation {
    condition     = var.secret_recovery_window_days == 0 || (var.secret_recovery_window_days >= 7 && var.secret_recovery_window_days <= 30)
    error_message = "secret_recovery_window_days must be 0 or 7-30."
  }
}

variable "tags" {
  description = "Extra tags merged into every resource."
  type        = map(string)
  default     = {}
}
