# NOTE: no password, username secret, or connection string with credentials is
# output here by design. The AUTH credential lives only in the dedicated
# Secrets Manager secret; Wave 7 wires application access through ESO.

output "endpoint_address" {
  description = "Cache endpoint hostname (TLS port 6379; no credentials)."
  value       = aws_elasticache_serverless_cache.this.endpoint[0].address
}

output "endpoint_port" {
  description = "Cache endpoint port (6379)."
  value       = aws_elasticache_serverless_cache.this.endpoint[0].port
}

output "cache_arn" {
  description = "Serverless cache ARN."
  value       = aws_elasticache_serverless_cache.this.arn
}

output "cache_name" {
  description = "Serverless cache name."
  value       = aws_elasticache_serverless_cache.this.name
}

output "user_secret_arn" {
  description = "ARN of the Secrets Manager secret holding {username,password} (ESO chess-redis source)."
  value       = aws_secretsmanager_secret.redis.arn
}

output "security_group_id" {
  description = "Redis security group ID."
  value       = aws_security_group.redis.id
}

output "full_engine_version" {
  description = "Resolved engine version (proves which Valkey the cache runs)."
  value       = aws_elasticache_serverless_cache.this.full_engine_version
}
