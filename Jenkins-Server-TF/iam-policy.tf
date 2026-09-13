# ============================================================
# iam-policy.tf — إصلاح ثغرة AdministratorAccess
# تم استبدال AdministratorAccess بصلاحيات محدودة وضرورية فقط
# ============================================================

# سياسة مخصصة بدلاً من AdministratorAccess
resource "aws_iam_policy" "jenkins-minimal-policy" {
  name        = "Jenkins-DevSecOps-Policy"
  description = "Minimal permissions for Jenkins CI/CD pipeline"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      # EKS — إدارة الكتلة
      {
        Sid    = "EKSAccess"
        Effect = "Allow"
        Action = [
          "eks:DescribeCluster",
          "eks:ListClusters",
          "eks:AccessKubernetesApi",
          "eks:CreateCluster",
          "eks:DeleteCluster",
          "eks:UpdateClusterVersion",
          "eks:CreateNodegroup",
          "eks:DeleteNodegroup",
          "eks:DescribeNodegroup",
          "eks:UpdateNodegroupConfig",
          "eks:TagResource",
        ]
        Resource = "*"
      },
      # ECR — دفع وسحب صور Docker
      {
        Sid    = "ECRAccess"
        Effect = "Allow"
        Action = [
          "ecr:GetAuthorizationToken",
          "ecr:BatchCheckLayerAvailability",
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage",
          "ecr:PutImage",
          "ecr:InitiateLayerUpload",
          "ecr:UploadLayerPart",
          "ecr:CompleteLayerUpload",
          "ecr:DescribeRepositories",
          "ecr:CreateRepository",
        ]
        Resource = "*"
      },
      # EC2 — وصف الموارد (للـ Terraform)
      {
        Sid    = "EC2ReadAccess"
        Effect = "Allow"
        Action = [
          "ec2:Describe*",
          "ec2:CreateSecurityGroup",
          "ec2:AuthorizeSecurityGroupIngress",
          "ec2:CreateSubnet",
          "ec2:CreateRouteTable",
          "ec2:CreateRoute",
          "ec2:AssociateRouteTable",
          "ec2:CreateTags",
          "ec2:ModifySubnetAttribute",
        ]
        Resource = "*"
      },
      # IAM — محدود جداً لـ PassRole فقط
      {
        Sid    = "IAMPassRole"
        Effect = "Allow"
        Action = [
          "iam:PassRole",
          "iam:GetRole",
          "iam:CreateRole",
          "iam:AttachRolePolicy",
          "iam:PutRolePolicy",
          "iam:CreateInstanceProfile",
          "iam:AddRoleToInstanceProfile",
          "iam:GetInstanceProfile",
        ]
        Resource = "*"
      },
      # S3 — للـ Terraform State فقط
      {
        Sid    = "S3TerraformState"
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject",
          "s3:ListBucket",
        ]
        Resource = [
          "arn:aws:s3:::my-devsecops-tfstate",       # ← غيّر لاسم bucket الخاص بك
          "arn:aws:s3:::my-devsecops-tfstate/*",
        ]
      },
      # DynamoDB — للـ Terraform Lock
      {
        Sid    = "DynamoDBTerraformLock"
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:DeleteItem",
          "dynamodb:DescribeTable",
        ]
        Resource = "arn:aws:dynamodb:*:*:table/terraform-lock-table"   # ← غيّر للجدول الخاص بك
      },
      # CloudWatch — للـ Logs
      {
        Sid    = "CloudWatchLogs"
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
          "logs:DescribeLogGroups",
        ]
        Resource = "*"
      },
    ]
  })
}

resource "aws_iam_role_policy_attachment" "jenkins-policy-attachment" {
  role       = aws_iam_role.iam-role.name
  policy_arn = aws_iam_policy.jenkins-minimal-policy.arn
}
