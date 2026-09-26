# State bucket: versioned (state recovery), SSE-S3 encrypted, private,
# TLS-only, access-logged to a dedicated log bucket. Deletion is guarded by
# lifecycle prevent_destroy: losing the state bucket orphans all environments.

resource "aws_s3_bucket" "state" {
  bucket = var.state_bucket_name

  tags = { Name = var.state_bucket_name }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket = aws_s3_bucket.state.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# Prune old state versions (cost hygiene); current versions are never expired.
resource "aws_s3_bucket_lifecycle_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    id     = "prune-old-versions"
    status = "Enabled"

    noncurrent_version_expiration {
      noncurrent_days = 90
    }
  }
}

# Deny any non-TLS access to state (data in transit).
resource "aws_s3_bucket_policy" "state_tls_only" {
  bucket = aws_s3_bucket.state.id
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{
      Sid       = "DenyNonTLS"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [
        aws_s3_bucket.state.arn,
        "${aws_s3_bucket.state.arn}/*",
      ]
      Condition = {
        Bool = { "aws:SecureTransport" = "false" }
      }
    }]
  })
}

# --- Dedicated access-log bucket (same hardening; short lifecycle). ---

resource "aws_s3_bucket" "logs" {
  bucket = "${var.state_bucket_name}-logs"

  tags = { Name = "${var.state_bucket_name}-logs" }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_versioning" "logs" {
  bucket = aws_s3_bucket.logs.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "logs" {
  bucket = aws_s3_bucket.logs.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "logs" {
  bucket = aws_s3_bucket.logs.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "logs" {
  bucket = aws_s3_bucket.logs.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "logs" {
  bucket = aws_s3_bucket.logs.id

  rule {
    id     = "expire-access-logs"
    status = "Enabled"

    expiration {
      days = var.log_retention_days
    }
  }
}

resource "aws_s3_bucket_logging" "state" {
  bucket        = aws_s3_bucket.state.id
  target_bucket = aws_s3_bucket.logs.id
  target_prefix = "state-access/"
}

# Grant the S3 log-delivery service write access to the target: required now
# that the log bucket disables ACLs (BucketOwnerEnforced). Scoped to this
# account and the state bucket via conditions.
resource "aws_s3_bucket_policy" "logs_delivery" {
  bucket = aws_s3_bucket.logs.id
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{
      Sid       = "AllowLogDelivery"
      Effect    = "Allow"
      Principal = { Service = "logging.s3.amazonaws.com" }
      Action    = "s3:PutObject"
      Resource  = "${aws_s3_bucket.logs.arn}/*"
      Condition = {
        StringEquals = {
          "aws:SourceAccount" = data.aws_caller_identity.current.account_id
        }
        ArnLike = {
          "aws:SourceArn" = aws_s3_bucket.state.arn
        }
      }
    }]
  })
}
