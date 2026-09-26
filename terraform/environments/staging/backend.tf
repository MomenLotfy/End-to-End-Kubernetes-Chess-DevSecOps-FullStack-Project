# Partial S3 backend: bucket/key/region are injected at init time via
# -backend-config (see backend.staging.hcl.example) so no account-specific
# bucket name is committed. Native S3 locking (no DynamoDB).

terraform {
  backend "s3" {}
}
