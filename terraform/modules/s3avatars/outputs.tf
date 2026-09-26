# NOTE: the bucket ARN feeds the backend IRSA policy (staging root) and the
# bucket NAME feeds GitOps values (S3_AVATARS_BUCKET). No credential output
# exists — pod auth is IRSA (web identity), never static keys.

output "bucket_name" {
  description = "Avatar bucket name (GitOps value: avatars.bucket)."
  value       = aws_s3_bucket.this.id
}

output "bucket_arn" {
  description = "Avatar bucket ARN (IRSA policy scope)."
  value       = aws_s3_bucket.this.arn
}
