variable "aws-region" {
  description = "AWS region for all resources"
  type        = string
  default     = "us-east-1"
}

variable "vpc-name" {
  description = "Name tag of existing VPC created by Jenkins-Server-TF"
  type        = string
}

variable "igw-name" {
  description = "Name tag of existing Internet Gateway"
  type        = string
}

variable "rt-name2" {
  description = "Name for the second route table"
  type        = string
}

variable "subnet-name" {
  description = "Name tag of existing subnet (us-east-1a)"
  type        = string
}

variable "subnet-name2" {
  description = "Name for the second subnet (us-east-1b)"
  type        = string
}

variable "security-group-name" {
  description = "Name tag of existing security group"
  type        = string
}

variable "cluster-name" {
  description = "EKS cluster name"
  type        = string
}

variable "eksnode-group-name" {
  description = "EKS managed node group name"
  type        = string
}

variable "eks-version" {
  description = "Kubernetes version for EKS cluster"
  type        = string
  default     = "1.33"    # تحديث: كان 1.28
}

variable "node-instance-type" {
  description = "EC2 instance type for worker nodes"
  type        = string
  default     = "t3.medium"   # تحديث: كان t2.medium (t3 أحدث وأسرع بنفس السعر)
}

variable "node-desired-size" {
  description = "Desired number of worker nodes"
  type        = number
  default     = 2
}

variable "node-max-size" {
  description = "Maximum number of worker nodes"
  type        = number
  default     = 4
}

variable "node-min-size" {
  description = "Minimum number of worker nodes"
  type        = number
  default     = 1
}
