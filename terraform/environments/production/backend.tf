# Partial S3 backend: bucket/key/region injected via -backend-config
# (see backend.production.hcl.example). Separate state key from staging.

terraform {
  backend "s3" {}
}
