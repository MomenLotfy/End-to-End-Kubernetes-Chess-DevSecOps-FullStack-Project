# Wave 3 — ECR Release Package (user-side runbook)

This directory contains everything needed to stand up the trusted release pipeline.
No Terraform, no EKS, no app changes — only the artifact path to ECR.

## Contents

| File | Purpose |
|---|---|
| `iam-trust-policy.json` | OIDC trust template (`__AWS_ACCOUNT_ID__` substituted by setup.sh). Allows **only** `repo:MomenLotfy/End-to-End-Kubernetes-Chess-DevSecOps-FullStack-Project` on `refs/heads/main` or the `production` environment, audience `sts.amazonaws.com`. No wildcards. |
| `iam-permissions-policy.json` | Least-privilege ECR push template. `GetAuthorizationToken` (AWS-mandated `*`) + push/pull/describe on the 3 `chess-*` repos only. **Cannot**: delete images/repos, create repos, or touch EKS/EC2/IAM/S3/RDS (no such statements; no `*` actions; no `AdministratorAccess`). |
| `ecr-lifecycle-policy.json` | Keep last 30 `sha-*` images per repo; expire untagged after 7 days. Tag mutability stays MUTABLE by decision (emergency same-tag re-push during rollback stays possible); deployment truth is the digest, and every release uses a unique `sha-<short>` tag, so mutability is never exercised in the normal path. |
| `setup.sh` | Idempotent AWS setup (admin creds, run once per account/region). |
| `make-metadata.sh` | Builds `release-metadata-<name>.json` (used by the workflow; testable locally). |

## Image set (derived from the repo, not invented)

`chess-backend` (Chess-Backend), `chess-frontend` (Chess-Frontend),
`chess-migration` (Database/migrations). `postgres:16-alpine` is upstream (not built);
`postgres-integration-tests` is test-only (never released).

## Tagging & identity

`sha-<12-char-commit>` per image (unique per commit) → pushed → digest captured from ECR →
digest signed (cosign keyless) + SBOM attested → metadata JSON links
commit → tag → digest → SBOM(sha256) → signature identity. `latest` is never created.
Rollback (Wave 5+) = redeploy the previous **digest**.

## User-side setup (AWS)

```bash
# 1) One-time AWS setup (needs an admin-capable profile; creates no secrets)
AWS_REGION=us-east-1 AWS_PROFILE=<admin-profile> ./release/setup.sh
#    → note the printed Role ARN

# 2) GitHub repo → Settings → Secrets and variables → Variables → New repository variable
#      AWS_RELEASE_ROLE_ARN = arn:aws:iam::<account>:role/chess-ecr-release
#      AWS_REGION           = us-east-1

# 3) GitHub repo → Settings → Environments → New environment: production
#      Deployment branches: Selected branches → main only
#      (No required reviewers/wait timer: merge + `ci` gates are the control.)

# 4) Trigger: push an app change to main (or Actions → release → Run workflow)

# 5) Validate (USER-SIDE AWS VALIDATION REQUIRED until this runs green):
#      - Actions → release → green; download `release-index` artifact
aws ecr describe-images --repository-name chess-backend --region us-east-1 \
  --query 'sort_by(imageDetails,& imagePushedAt)[-1].{digest:imageDigest,tags:imageTags}'
cosign verify <registry>/chess-backend@<digest> \
  --certificate-identity-regexp '^https://github.com/MomenLotfy/End-to-End-Kubernetes-Chess-DevSecOps-FullStack-Project/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
cosign verify-attestation --type https://spdx.dev/Document \
  --certificate-identity-regexp '^https://github.com/MomenLotfy/End-to-End-Kubernetes-Chess-DevSecOps-FullStack-Project/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  <registry>/chess-backend@<digest>
```

Region rationale: `us-east-1` — lowest-cost region with full ECR/Sigstore-independent
availability, consistent with all legacy references; changing region later = one variable
+ re-run of setup.sh in the new region.

## Verify-before Wave 5 (admission)

`cosign verify` / `verify-attestation` commands above are the exact predicates Wave 5's
Kyverno `verifyImages` will enforce. Enforcement stays OFF until the signing chain has
proven green here.

## Wave 5: GitOps commit-back (staging delivery)

After `release-index` builds, the `gitops-commit-back` job writes the 3 image
digests into the SEPARATE gitops repo (`apps/chess/staging/images.yaml`);
ArgoCD syncs EKS staging from there. The chart refuses to render without
valid digests, so staging can only ever run released, scanned, signed images.

- Script: `release/gitops-commit-back.py` (stdlib only, line-preserving,
  schema-drift + weak-digest fail-closed; fixture-tested by
  `scripts/wave5-static-checks.py`)
- Auth: `vars.GITOPS_REPO` (`<OWNER>/chess-gitops`) + `secrets.GITOPS_REPO_TOKEN`
  (fine-grained PAT, contents:write on the gitops repo ONLY). Never GITHUB_TOKEN.
- Bootstrap: job SKIPS with a notice until both are configured (releases still
  succeed). Once configured, failures are real (no `continue-on-error`).
- Rollback: `git revert` the digest commit in the gitops repo; ArgoCD re-syncs
  the previous digests (app rollback; DB stays forward-only per runbook).
