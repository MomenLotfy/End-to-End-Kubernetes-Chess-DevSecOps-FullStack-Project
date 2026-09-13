resource "aws_eks_node_group" "eks-node-group" {
  cluster_name    = aws_eks_cluster.eks-cluster.name
  node_group_name = var.eksnode-group-name
  node_role_arn   = aws_iam_role.NodeGroupRole.arn
  subnet_ids      = [data.aws_subnet.subnet.id, aws_subnet.public-subnet2.id]

  scaling_config {
    desired_size = var.node-desired-size
    max_size     = var.node-max-size
    min_size     = var.node-min-size
  }

  # تحديث: AL2023 بدلاً من AL2_x86_64 (Amazon Linux 2 قديم)
  # AL2023 هو النظام الرسمي الموصى به من AWS لـ EKS 1.30+
  ami_type       = "AL2023_x86_64_STANDARD"
  instance_types = [var.node-instance-type]    # t3.medium: أحدث وأسرع من t2.medium
  disk_size      = 20

  # تحسين: إدارة التحديثات مع تقليل التأثير
  update_config {
    max_unavailable = 1
  }

  # تحسين: تفعيل launch template لتخصيص أكثر
  labels = {
    Environment = "dev"
    NodeGroup   = var.eksnode-group-name
  }

  depends_on = [
    aws_iam_role_policy_attachment.AmazonEKSWorkerNodePolicy,
    aws_iam_role_policy_attachment.AmazonEC2ContainerRegistryReadOnly,
    aws_iam_role_policy_attachment.AmazonEKS_CNI_Policy,
  ]

  tags = {
    Name = var.eksnode-group-name
  }

  # منع إعادة إنشاء Node Group عند تغيير الـ desired_size فقط
  lifecycle {
    ignore_changes = [scaling_config[0].desired_size]
  }
}
