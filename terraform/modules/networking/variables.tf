# Variables for the networking module. Defaults are staging-oriented; production
# overrides az_count/single_nat_gateway/retention via its environment root.

variable "project" {
  description = "Project slug used in resource names and tags (lowercase)."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9-]+$", var.project))
    error_message = "project must be lowercase alphanumeric with hyphens (used in AWS names)."
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

variable "vpc_cidr" {
  description = "VPC CIDR. Must NOT overlap the legacy Jenkins VPC (10.0.0.0/16) so both can coexist in one account during migration."
  type        = string
  default     = "10.20.0.0/16"

  validation {
    condition     = can(cidrhost(var.vpc_cidr, 0)) && tonumber(split("/", var.vpc_cidr)[1]) <= 20
    error_message = "vpc_cidr must be a valid CIDR of /20 or larger (nine /20 slices are carved from it)."
  }
}

variable "az_count" {
  description = "Number of Availability Zones (2 staging, 3 production)."
  type        = number
  default     = 2

  validation {
    condition     = var.az_count >= 2 && var.az_count <= 3
    error_message = "az_count must be 2 or 3 (subnet math reserves netnums for at most 3 AZs)."
  }
}

variable "single_nat_gateway" {
  description = "true = one NAT gateway (staging cost saving, AZ-failure tradeoff); false = one NAT per AZ (production resilience)."
  type        = bool
  default     = true
}

variable "cluster_name" {
  description = "EKS cluster name for subnet discovery tags (null omits the kubernetes.io/cluster tag)."
  type        = string
  default     = null
}

variable "enable_flow_logs" {
  description = "Enable VPC flow logs to CloudWatch."
  type        = bool
  default     = true
}

variable "flow_log_retention_days" {
  description = "CloudWatch retention for VPC flow logs."
  type        = number
  default     = 30
}

variable "tags" {
  description = "Extra tags merged into every resource."
  type        = map(string)
  default     = {}
}
