resource "aws_iam_role" "EKSClusterRole" {
  name = "EKSClusterRole-${var.cluster-name}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "eks.amazonaws.com" }
    }]
  })

  tags = { Name = "EKSClusterRole" }
}

resource "aws_iam_role" "NodeGroupRole" {
  name = "EKSNodeGroupRole-${var.cluster-name}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
    }]
  })

  tags = { Name = "EKSNodeGroupRole" }
}
