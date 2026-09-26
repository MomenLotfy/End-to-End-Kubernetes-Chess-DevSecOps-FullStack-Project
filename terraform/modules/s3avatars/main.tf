# Wave 7 — s3avatars module: the private avatar object store.
#
# Security posture (all asserted by scripts/wave7-static-checks.py):
# - Block Public Access (all four flags) + BucketOwnerEnforced ownership:
#   public reads and cross-account ACLs are structurally impossible.
# - SSE-S3 default encryption (aws:kms CMK binding is a Wave 8 compliance
#   hardening, matching the Wave 5 EBS precedent — not a staging need).
# - Bucket policy denies non-TLS access (same DenyNonTLS shape as bootstrap).
# - Versioning is explicitly DISABLED: avatar objects are immutable
#   (content-unique uuid names, "wx" no-overwrite writes), so versions would
#   only multiply storage cost without a recovery story. Point-in-time avatar
#   recovery is not a staging requirement.
# - Lifecycle: abort incomplete multipart uploads after 7 days (SDK retries
#   must not leak partial objects forever). No expiration: avatars are user
#   content; orphan cleanup is an explicit reconciler (see S3 runbook), never
#   a blind TTL.
# - force_destroy = false: the bucket refuses `terraform destroy` while it
#   still holds user content.
#
# Access model: NOTHING in this module grants access. Read/write/delete on
# arn:…/avatars/* is granted to the backend IRSA role in the staging root
# (least privilege: three object actions, one prefix, no ListBucket — the pod
# addresses keys directly; backfill listing runs from an admin machine).

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

locals {
  prefix = "${var.project}-${var.environment}"
  bucket = coalesce(var.bucket_name, "${local.prefix}-avatars")
}

resource "aws_s3_bucket" "this" {
  bucket        = local.bucket
  force_destroy = false

  tags = merge(var.tags, { Name = local.bucket })
}

resource "aws_s3_bucket_ownership_controls" "this" {
  bucket = aws_s3_bucket.this.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "this" {
  bucket = aws_s3_bucket.this.id

  block_public_acls       = true
  ignore_public_acls      = true
  block_public_policy     = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  bucket = aws_s3_bucket.this.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_versioning" "this" {
  bucket = aws_s3_bucket.this.id

  versioning_configuration {
    # Disabled by explicit Wave 7 decision (see header): immutable objects.
    status = "Disabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "this" {
  bucket = aws_s3_bucket.this.id

  rule {
    id     = "abort-incomplete-multipart-uploads"
    status = "Enabled"

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

resource "aws_s3_bucket_policy" "tls_only" {
  bucket = aws_s3_bucket.this.id

  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{
      Sid       = "DenyNonTLS"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [
        aws_s3_bucket.this.arn,
        "${aws_s3_bucket.this.arn}/*",
      ]
      Condition = {
        Bool = { "aws:SecureTransport" = "false" }
      }
    }]
  })

  depends_on = [aws_s3_bucket_public_access_block.this]
}
