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

variable "identifier" {
  description = "RDS instance identifier (default: <project>-<environment>-postgres)."
  type        = string
  default     = null
}

variable "engine_version" {
  description = "PostgreSQL major version (minor auto-upgrades stay on)."
  type        = string
  default     = "16"

  validation {
    condition     = can(regex("^(1[4-9]|[2-9][0-9])$", var.engine_version))
    error_message = "engine_version must be a supported PostgreSQL major (14+ at Wave 4 design time)."
  }
}

variable "instance_class" {
  description = "RDS instance class (staging: db.t4g.micro)."
  type        = string
  default     = "db.t4g.micro"
}

variable "db_name" {
  description = "Initial database name (matches the application default)."
  type        = string
  default     = "chess_db"
}

variable "master_username" {
  description = "Master (admin) username. The application later gets a LEAST-PRIVILEGE app user, not this identity."
  type        = string
  default     = "chess_admin"
}

variable "allocated_storage_gb" {
  description = "Initial storage in GB."
  type        = number
  default     = 20
}

variable "max_allocated_storage_gb" {
  description = "Autoscaling storage ceiling in GB (0 disables autoscaling)."
  type        = number
  default     = 100
}

variable "multi_az" {
  description = "Multi-AZ standby (false staging, true production)."
  type        = bool
  default     = false
}

variable "backup_retention_days" {
  description = "Automated backup retention in days (PITR window)."
  type        = number
  default     = 7

  validation {
    condition     = var.backup_retention_days >= 1 && var.backup_retention_days <= 35
    error_message = "backup_retention_days must be within the RDS-supported 1-35 range."
  }
}

variable "backup_window" {
  description = "Daily backup window (UTC)."
  type        = string
  default     = "03:00-04:00"
}

variable "maintenance_window" {
  description = "Weekly maintenance window (UTC)."
  type        = string
  default     = "sun:04:00-sun:05:00"
}

variable "skip_final_snapshot" {
  description = "Skip final snapshot on destroy (true staging / disposable; false production)."
  type        = bool
  default     = true
}

variable "vpc_id" {
  description = "VPC ID hosting RDS."
  type        = string
}

variable "data_subnet_ids" {
  description = "PRIVATE data subnet IDs for the DB subnet group (must span 2+ AZs)."
  type        = list(string)

  validation {
    condition     = length(var.data_subnet_ids) >= 2
    error_message = "RDS subnet groups require subnets in at least 2 Availability Zones."
  }
}

variable "allowed_source_security_group_id" {
  description = "The ONLY ingress source for 5432: the EKS-managed cluster security group ID."
  type        = string
}

variable "performance_insights_enabled" {
  description = "Enable Performance Insights (7-day retention is free-tier)."
  type        = bool
  default     = true
}

variable "performance_insights_retention_days" {
  description = "Performance Insights retention (7 free; 731 paid long-term)."
  type        = number
  default     = 7
}

variable "monitoring_interval_seconds" {
  description = "Enhanced Monitoring interval, 0 disables (staging default; Wave 6 may enable)."
  type        = number
  default     = 0
}

variable "tags" {
  description = "Extra tags merged into every resource."
  type        = map(string)
  default     = {}
}
