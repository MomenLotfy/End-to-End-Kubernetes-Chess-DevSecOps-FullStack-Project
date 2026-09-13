variable "aws-region" {
  description = "AWS region"
  type        = string
  default     = "us-east-1"
}

variable "vpc-name" {
  description = "VPC name tag"
  type        = string
}

variable "igw-name" {
  description = "Internet Gateway name tag"
  type        = string
}

variable "rt-name" {
  description = "Route Table name tag"
  type        = string
}

variable "subnet-name" {
  description = "Subnet name tag"
  type        = string
}

variable "sg-name" {
  description = "Security Group name tag"
  type        = string
}

variable "instance-name" {
  description = "EC2 instance name tag"
  type        = string
}

variable "key-name" {
  description = "AWS Key Pair name for SSH access"
  type        = string
}

variable "iam-role" {
  description = "IAM Role name for Jenkins EC2"
  type        = string
}

variable "instance-type" {
  description = "EC2 instance type for Jenkins server"
  type        = string
  default     = "t3.2xlarge"  # تحديث: t3 أحدث وأرخص بـ 10% من t2
}

variable "volume-size" {
  description = "Root EBS volume size in GB"
  type        = number
  default     = 40            # تحديث: زيادة من 30 إلى 40 لتجنب نفاد المساحة
}
