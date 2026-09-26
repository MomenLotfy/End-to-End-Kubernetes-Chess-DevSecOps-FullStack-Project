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
  description = "EKS cluster name (default: <project>-<environment>-eks). Passed to subnet discovery tags."
  type        = string
  default     = null
}

variable "kubernetes_version" {
  description = "EKS Kubernetes version. Verify currency with `aws eks describe-cluster-versions` before apply."
  type        = string
  default     = "1.35"

  validation {
    condition     = can(regex("^1\\.[0-9]+$", var.kubernetes_version)) && tonumber(split(".", var.kubernetes_version)[1]) >= 34
    error_message = "kubernetes_version must be 1.34+ (1.33 and below are past EKS standard support at Wave 4 design time, Sept 2026)."
  }
}

variable "vpc_id" {
  description = "VPC ID hosting the cluster."
  type        = string
}

variable "app_subnet_ids" {
  description = "PRIVATE application subnet IDs for control-plane ENIs and worker nodes. Never public subnets."
  type        = list(string)

  validation {
    condition     = length(var.app_subnet_ids) >= 2
    error_message = "EKS requires subnets in at least 2 Availability Zones."
  }
}

variable "public_access_cidrs" {
  description = "Owner/admin CIDRs allowed to reach the public API endpoint. Default [] = NO public endpoint (fail closed). Set your IP/nat-gateway CIDR to run kubectl without VPN."
  type        = list(string)
  default     = []

  validation {
    condition     = !contains(var.public_access_cidrs, "0.0.0.0/0")
    error_message = "Refusing unrestricted 0.0.0.0/0 API access: list explicit admin CIDRs."
  }
}

variable "admin_role_arn" {
  description = "IAM role/user ARN granted cluster-admin via access entry (owner identity)."
  type        = string

  validation {
    condition     = can(regex("^arn:[a-z0-9-]+:iam::[0-9]{12}:(role|user)/", var.admin_role_arn))
    error_message = "admin_role_arn must be a valid IAM role/user ARN."
  }
}

variable "node_instance_types" {
  description = "Node group instance types."
  type        = list(string)
  default     = ["t3.medium"]
}

variable "node_desired_size" {
  description = "Desired node count (platform headroom; the chess backend itself stays 1 replica until Wave 7)."
  type        = number
  default     = 2
}

variable "node_min_size" {
  description = "Minimum node count."
  type        = number
  default     = 1
}

variable "node_max_size" {
  description = "Maximum node count."
  type        = number
  default     = 3
}

variable "node_disk_size_gb" {
  description = "Node root volume size in GB."
  type        = number
  default     = 20
}

variable "enabled_log_types" {
  description = "Control-plane log types (security signals; scheduler/controllerManager omitted as noisy for staging)."
  type        = list(string)
  default     = ["api", "audit", "authenticator"]
}

variable "log_retention_days" {
  description = "CloudWatch retention for control-plane logs."
  type        = number
  default     = 30
}

variable "enable_ebs_csi" {
  description = "Wave 5: install the EBS CSI driver managed add-on with a dedicated IRSA role (uploads PVC)."
  type        = bool
  default     = false
}

variable "enable_lb_controller" {
  description = "Wave 5: install the AWS Load Balancer Controller managed add-on with a dedicated IRSA role (ALB Ingress)."
  type        = bool
  default     = false
}

variable "enable_metrics_server" {
  description = "Wave 6: install the metrics-server managed add-on (Kubernetes resource metrics; no IRSA role — it needs no AWS identity)."
  type        = bool
  default     = false
}

variable "tags" {
  description = "Extra tags merged into every resource."
  type        = map(string)
  default     = {}
}
