output "role_arns" {
  description = "IRSA role ARNs by role key (empty map in Wave 4)."
  value       = { for k, r in aws_iam_role.irsa : k => r.arn }
}
