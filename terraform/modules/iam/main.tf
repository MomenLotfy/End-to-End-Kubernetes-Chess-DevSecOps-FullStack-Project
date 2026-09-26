# Wave 4 — iam module: IRSA role factory (ServiceAccount -> OIDC -> IAM role).
# Instantiated with an EMPTY role map in Wave 4: the OIDC trust anchor exists
# (eks module), the factory is validated, but no workload permissions are
# granted yet. Wave 5 adds EBS CSI / ALB controller / ESO roles through this
# same map — no new trust plumbing required.

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
  # OIDC condition key uses the issuer host WITHOUT scheme.
  oidc_host = replace(var.oidc_provider_url, "https://", "")
}

resource "aws_iam_role" "irsa" {
  for_each = var.roles
  name     = "${local.prefix}-${each.key}"

  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = {
        Federated = var.oidc_provider_arn
      }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "${local.oidc_host}:aud" = "sts.amazonaws.com"
          "${local.oidc_host}:sub" = "system:serviceaccount:${each.value.namespace}:${each.value.service_account}"
        }
      }
    }]
  })

  description = each.value.description

  tags = merge(var.tags, { Name = "${local.prefix}-${each.key}" })
}

# Inline least-privilege policy per role (empty statement list = no policy).
resource "aws_iam_role_policy" "irsa" {
  for_each = { for k, v in var.roles : k => v if length(v.policy_statements) > 0 }
  name     = "${local.prefix}-${each.key}"
  role     = aws_iam_role.irsa[each.key].id

  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = each.value.policy_statements
  })
}

# Optional AWS-managed policy attachments per role. flatten (not merge with
# expansion) so the empty default roles={} evaluates cleanly to zero instances.
resource "aws_iam_role_policy_attachment" "irsa" {
  for_each = {
    for pair in flatten([
      for role_key, role in var.roles : [
        for arn in role.managed_policy_arns : {
          key        = "${role_key}::${replace(arn, "/[^a-zA-Z0-9]+/", "-")}"
          role_key   = role_key
          policy_arn = arn
        }
      ]
    ]) : pair.key => pair
  }

  role       = aws_iam_role.irsa[each.value.role_key].name
  policy_arn = each.value.policy_arn
}
