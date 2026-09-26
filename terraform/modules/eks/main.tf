# Wave 4 — EKS module: private managed node groups, private API endpoint with
# optional CIDR-restricted public access (fail-closed default: none), envelope
# encryption of Kubernetes secrets via dedicated KMS key, control-plane logging,
# OIDC provider for IRSA, and API-mode access entries (no aws-auth ConfigMap).
#
# Deliberately NOT in Wave 4: ALB controller, EBS CSI driver, ESO, Cluster
# Autoscaler, HPA/PDB, NetworkPolicies — Wave 5+ owns the application platform.
# Backend stays 1 replica/process (Wave 7 owns scale-out); node sizing below is
# platform headroom, not application scaling.

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
  }
}

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  prefix       = "${var.project}-${var.environment}"
  cluster_name = coalesce(var.cluster_name, "${local.prefix}-eks")
  # Public API access exists ONLY when the owner lists explicit CIDRs.
  # Default [] => endpoint_public_access = false (fail closed).
  public_access_enabled = length(var.public_access_cidrs) > 0
  # OIDC condition key uses the issuer host WITHOUT scheme.
  oidc_host = replace(aws_eks_cluster.this.identity[0].oidc[0].issuer, "https://", "")
}

# --- KMS: dedicated envelope-encryption key for Kubernetes secrets. ---
# Key policy follows the AWS default pattern: account root holds kms:* and
# delegates through IAM. Resource "*" is REQUIRED in key policies (the key ARN
# attachment itself is the scope) — see AWS KMS developer guide.

resource "aws_kms_key" "eks_secrets" {
  description             = "EKS secrets envelope encryption for ${local.cluster_name}"
  enable_key_rotation     = true
  deletion_window_in_days = 30

  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{
      Sid       = "EnableIamUserPolicies"
      Effect    = "Allow"
      Principal = { AWS = "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:root" }
      Action    = "kms:*"
      Resource  = "*"
    }]
  })

  tags = merge(var.tags, { Name = "${local.prefix}-eks-secrets" })
}

resource "aws_kms_alias" "eks_secrets" {
  name          = "alias/${local.prefix}-eks-secrets"
  target_key_id = aws_kms_key.eks_secrets.key_id
}

# --- Control-plane log group (created first so retention/tagging is managed). ---

resource "aws_cloudwatch_log_group" "cluster" {
  name              = "/aws/eks/${local.cluster_name}/cluster"
  retention_in_days = var.log_retention_days

  tags = merge(var.tags, { Name = "${local.cluster_name}-logs" })
}

# --- Cluster IAM role: EKS service only, AWS-managed cluster policy only. ---

resource "aws_iam_role" "cluster" {
  name = "${local.prefix}-eks-cluster"

  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "eks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = merge(var.tags, { Name = "${local.prefix}-eks-cluster" })
}

resource "aws_iam_role_policy_attachment" "cluster" {
  role       = aws_iam_role.cluster.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AmazonEKSClusterPolicy"
}

# --- Node IAM role: EC2 nodes only. No application permissions live here;
# workloads get their own IRSA roles from the iam module (Wave 5+). ---

resource "aws_iam_role" "nodes" {
  name = "${local.prefix}-eks-nodes"

  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = merge(var.tags, { Name = "${local.prefix}-eks-nodes" })
}

resource "aws_iam_role_policy_attachment" "node_worker" {
  role       = aws_iam_role.nodes.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AmazonEKSWorkerNodePolicy"
}

resource "aws_iam_role_policy_attachment" "node_cni" {
  role       = aws_iam_role.nodes.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AmazonEKS_CNI_Policy"
}

resource "aws_iam_role_policy_attachment" "node_ecr" {
  role       = aws_iam_role.nodes.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"
}

# --- Cluster: private subnets, private endpoint always on. ---

resource "aws_eks_cluster" "this" {
  name     = local.cluster_name
  role_arn = aws_iam_role.cluster.arn
  version  = var.kubernetes_version

  vpc_config {
    subnet_ids              = var.app_subnet_ids
    endpoint_private_access = true
    endpoint_public_access  = local.public_access_enabled
    # null when disabled: the provider omits the field so the EKS API never
    # sees CIDRs alongside a disabled public endpoint.
    public_access_cidrs = local.public_access_enabled ? var.public_access_cidrs : null
  }

  encryption_config {
    provider {
      key_arn = aws_kms_key.eks_secrets.arn
    }
    resources = ["secrets"]
  }

  enabled_cluster_log_types = var.enabled_log_types

  access_config {
    authentication_mode                         = "API"
    bootstrap_cluster_creator_admin_permissions = true
  }

  depends_on = [
    aws_iam_role_policy_attachment.cluster,
    aws_cloudwatch_log_group.cluster,
  ]

  tags = merge(var.tags, { Name = local.cluster_name })
}

# Owner/admin access entry (API mode has no aws-auth ConfigMap fallback).
resource "aws_eks_access_entry" "admin" {
  cluster_name  = aws_eks_cluster.this.name
  principal_arn = var.admin_role_arn
  type          = "STANDARD"

  tags = merge(var.tags, { Name = "${local.prefix}-eks-admin" })
}

resource "aws_eks_access_policy_association" "admin" {
  cluster_name  = aws_eks_cluster.this.name
  principal_arn = var.admin_role_arn
  policy_arn    = "arn:${data.aws_partition.current.partition}:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy"

  access_scope {
    type = "cluster"
  }
}

# --- Managed node group: private subnets, AL2023, sized for staging. ---

resource "aws_eks_node_group" "this" {
  cluster_name    = aws_eks_cluster.this.name
  node_group_name = "${local.cluster_name}-ng"
  node_role_arn   = aws_iam_role.nodes.arn
  subnet_ids      = var.app_subnet_ids

  scaling_config {
    desired_size = var.node_desired_size
    min_size     = var.node_min_size
    max_size     = var.node_max_size
  }

  ami_type       = "AL2023_x86_64_STANDARD"
  instance_types = var.node_instance_types
  disk_size      = var.node_disk_size_gb

  update_config {
    max_unavailable = 1
  }

  labels = {
    Environment = var.environment
    ManagedBy   = "terraform"
  }

  depends_on = [
    aws_iam_role_policy_attachment.node_worker,
    aws_iam_role_policy_attachment.node_cni,
    aws_iam_role_policy_attachment.node_ecr,
  ]

  tags = merge(var.tags, { Name = "${local.cluster_name}-ng" })

  lifecycle {
    # Allows a future Cluster Autoscaler (Wave 5+) to adjust desired size
    # without fighting Terraform; min/max stay Terraform-managed.
    ignore_changes = [scaling_config[0].desired_size]
  }
}

# --- Core add-ons. most_recent=true avoids pinning EKS build versions that rot;
# Dependabot-style drift review happens via `terraform plan` diff on upgrade. ---

resource "aws_eks_addon" "coredns" {
  cluster_name = aws_eks_cluster.this.name
  addon_name   = "coredns"
  most_recent  = true

  tags = merge(var.tags, { Name = "${local.cluster_name}-coredns" })
}

resource "aws_eks_addon" "kube_proxy" {
  cluster_name = aws_eks_cluster.this.name
  addon_name   = "kube-proxy"
  most_recent  = true

  tags = merge(var.tags, { Name = "${local.cluster_name}-kube-proxy" })
}

resource "aws_eks_addon" "vpc_cni" {
  cluster_name = aws_eks_cluster.this.name
  addon_name   = "vpc-cni"
  most_recent  = true

  tags = merge(var.tags, { Name = "${local.cluster_name}-vpc-cni" })
}

# --- OIDC provider: the trust anchor for IRSA workload roles (iam module). ---

data "tls_certificate" "oidc" {
  url = aws_eks_cluster.this.identity[0].oidc[0].issuer
}

resource "aws_iam_openid_connect_provider" "this" {
  url             = aws_eks_cluster.this.identity[0].oidc[0].issuer
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = [data.tls_certificate.oidc.certificates[0].sha1_fingerprint]

  tags = merge(var.tags, { Name = "${local.prefix}-eks-oidc" })
}

# --- Wave 5 platform add-ons with dedicated IRSA roles (EBS CSI + AWS LB
# Controller). These cluster-platform identities live WITH the cluster module
# (not the workload-role factory) so no cross-module cycle exists: roles trust
# this module's own OIDC provider, add-ons consume the local role ARNs.
# Workload roles (ESO, future app roles) stay in modules/iam. ---

resource "aws_iam_role" "ebs_csi" {
  count = var.enable_ebs_csi ? 1 : 0
  name  = "${local.prefix}-ebs-csi"

  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = aws_iam_openid_connect_provider.this.arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "${local.oidc_host}:aud" = "sts.amazonaws.com"
          "${local.oidc_host}:sub" = "system:serviceaccount:kube-system:ebs-csi-controller-sa"
        }
      }
    }]
  })

  description = "Wave 5: EBS CSI driver (uploads PVC)"

  tags = merge(var.tags, { Name = "${local.prefix}-ebs-csi" })
}

resource "aws_iam_role_policy_attachment" "ebs_csi" {
  count      = var.enable_ebs_csi ? 1 : 0
  role       = aws_iam_role.ebs_csi[0].name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AmazonEBSCSIDriverPolicy"
}

resource "aws_eks_addon" "ebs_csi" {
  count                    = var.enable_ebs_csi ? 1 : 0
  cluster_name             = aws_eks_cluster.this.name
  addon_name               = "aws-ebs-csi-driver"
  most_recent              = true
  service_account_role_arn = aws_iam_role.ebs_csi[0].arn

  tags = merge(var.tags, { Name = "${local.cluster_name}-ebs-csi" })
}

resource "aws_iam_role" "lb_controller" {
  count = var.enable_lb_controller ? 1 : 0
  name  = "${local.prefix}-aws-lbc"

  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = aws_iam_openid_connect_provider.this.arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "${local.oidc_host}:aud" = "sts.amazonaws.com"
          "${local.oidc_host}:sub" = "system:serviceaccount:kube-system:aws-load-balancer-controller"
        }
      }
    }]
  })

  description = "Wave 5: AWS Load Balancer Controller (ALB Ingress)"

  tags = merge(var.tags, { Name = "${local.prefix}-aws-lbc" })
}

# AWS-managed LB controller policy. FALLBACK (USER-SIDE): if this managed
# policy ever disappears from the partition, create the customer policy from
# the versioned upstream file and attach it instead:
# https://raw.githubusercontent.com/kubernetes-sigs/aws-load-balancer-controller/<APP_VERSION>/docs/install/iam_policy.json
resource "aws_iam_role_policy_attachment" "lb_controller" {
  count      = var.enable_lb_controller ? 1 : 0
  role       = aws_iam_role.lb_controller[0].name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AWSLoadBalancerControllerIAMPolicy"
}

resource "aws_eks_addon" "lb_controller" {
  count                    = var.enable_lb_controller ? 1 : 0
  cluster_name             = aws_eks_cluster.this.name
  addon_name               = "aws-load-balancer-controller"
  most_recent              = true
  service_account_role_arn = aws_iam_role.lb_controller[0].arn

  tags = merge(var.tags, { Name = "${local.cluster_name}-aws-lbc" })
}

# Metrics Server has no service_account_role_arn: unlike the CSI/LB drivers it
# calls no AWS APIs (in-cluster aggregation only), so no IRSA role exists.
resource "aws_eks_addon" "metrics_server" {
  count        = var.enable_metrics_server ? 1 : 0
  cluster_name = aws_eks_cluster.this.name
  addon_name   = "metrics-server"
  most_recent  = true

  tags = merge(var.tags, { Name = "${local.cluster_name}-metrics-server" })
}
