resource "aws_eks_cluster" "eks-cluster" {
  name     = var.cluster-name
  role_arn = aws_iam_role.EKSClusterRole.arn
  version  = var.eks-version    # تحديث: كان مُرمَّزاً بـ 1.28

  vpc_config {
    subnet_ids         = [data.aws_subnet.subnet.id, aws_subnet.public-subnet2.id]
    security_group_ids = [data.aws_security_group.sg-default.id]

    # تحسين: تفعيل Public + Private endpoints
    endpoint_public_access  = true
    endpoint_private_access = true
  }

  # تحسين: تفعيل Logging للكتلة
  enabled_cluster_log_types = ["api", "audit", "authenticator", "controllerManager", "scheduler"]

  depends_on = [
    aws_iam_role_policy_attachment.AmazonEKSClusterPolicy,
    aws_cloudwatch_log_group.eks-logs,
  ]

  tags = {
    Name = var.cluster-name
  }
}

# جديد: CloudWatch Log Group لـ EKS
resource "aws_cloudwatch_log_group" "eks-logs" {
  name              = "/aws/eks/${var.cluster-name}/cluster"
  retention_in_days = 7

  tags = {
    Name = "${var.cluster-name}-logs"
  }
}
