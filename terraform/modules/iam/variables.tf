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

variable "cluster_name" {
  description = "EKS cluster name (informational; trust is bound to the OIDC provider)."
  type        = string
}

variable "oidc_provider_arn" {
  description = "IAM OIDC provider ARN from the eks module."
  type        = string
}

variable "oidc_provider_url" {
  description = "OIDC issuer URL (https://...) from the eks module."
  type        = string
}

variable "roles" {
  description = "IRSA roles to create. EMPTY in Wave 4 (foundation only); Wave 5 populates EBS CSI / ALB / ESO roles."
  type        = map(object({
    namespace           = string
    service_account     = string
    description         = string
    managed_policy_arns = optional(list(string), [])
    policy_statements   = optional(list(object({
      Sid      = string
      Effect   = string
      Action   = list(string)
      Resource = list(string)
      # NOTE: no Condition field yet — null Conditions serialize badly through
      # jsonencode. Wave 5 extends this object if a role needs conditions.
    })), [])
  }))
  default = {}

  validation {
    condition = alltrue([
      for r in values(var.roles) : !contains(flatten([for s in r.policy_statements : s.Action]), "*")
    ])
    error_message = "IRSA role statements must not use Action \"*\" (least privilege)."
  }
}

variable "tags" {
  description = "Extra tags merged into every resource."
  type        = map(string)
  default     = {}
}
