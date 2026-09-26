output "state_bucket_name" {
  description = "State bucket name (copy into backend.local.hcl files)."
  value       = aws_s3_bucket.state.id
}

output "log_bucket_name" {
  description = "Access-log bucket name."
  value       = aws_s3_bucket.logs.id
}
