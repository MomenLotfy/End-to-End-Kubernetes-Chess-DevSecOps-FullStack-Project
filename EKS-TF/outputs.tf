# ============================================================
# outputs.tf — ملف جديد: يُظهر معلومات الكتلة بعد الإنشاء
# ============================================================

output "cluster_name" {
  description = "EKS cluster name"
  value       = aws_eks_cluster.eks-cluster.name
}

output "cluster_endpoint" {
  description = "EKS cluster API server endpoint"
  value       = aws_eks_cluster.eks-cluster.endpoint
}

output "cluster_version" {
  description = "Kubernetes version running on the cluster"
  value       = aws_eks_cluster.eks-cluster.version
}

output "cluster_certificate_authority" {
  description = "Base64 encoded certificate data for cluster"
  value       = aws_eks_cluster.eks-cluster.certificate_authority[0].data
  sensitive   = true
}

output "node_group_status" {
  description = "Status of the managed node group"
  value       = aws_eks_node_group.eks-node-group.status
}

output "kubeconfig_command" {
  description = "Command to configure kubectl for this cluster"
  value       = "aws eks update-kubeconfig --region ${var.aws-region} --name ${var.cluster-name}"
}
