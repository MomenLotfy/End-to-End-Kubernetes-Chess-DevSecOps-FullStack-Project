# NOTE: no credential, password, or connection-string output exists here by
# design. The master password lives only in the RDS-managed Secrets Manager
# secret; Wave 5 wires application access through ESO.

output "endpoint" {
  description = "RDS connection endpoint (hostname only, no credentials)."
  value       = aws_db_instance.this.address
}

output "port" {
  description = "RDS port."
  value       = aws_db_instance.this.port
}

output "db_name" {
  description = "Initial database name."
  value       = aws_db_instance.this.db_name
}

output "security_group_id" {
  description = "RDS security group ID."
  value       = aws_security_group.rds.id
}

output "master_user_secret_arn" {
  description = "ARN of the RDS-managed master-user secret in Secrets Manager (Wave 5 ESO source)."
  value       = aws_db_instance.this.master_user_secret[0].secret_arn
}

output "kms_key_arn" {
  description = "RDS encryption KMS key ARN."
  value       = aws_kms_key.rds.arn
}
