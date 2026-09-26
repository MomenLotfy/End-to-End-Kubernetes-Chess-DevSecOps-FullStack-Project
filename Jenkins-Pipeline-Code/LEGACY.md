# LEGACY / NON-AUTHORITATIVE — do not use for new work

This directory (`Jenkins-Pipeline-Code/`) holds the retired Jenkins pipelines.
It is kept for reference only until the new foundation (`terraform/`, Wave 4) +
GitOps path (Wave 5) are proven, then archived.

- CI/CD authority is GitHub Actions (ADR-006): `.github/workflows/`
- Release authority is the OIDC/ECR/cosign pipeline (Wave 3): `release/`
- Jenkins credential IDs referenced here (`aws-key`, `docker`, `github`,
  `sonar-token`) live in the retired Jenkins, not in this repo; rotate the
  backing secrets (especially any AWS keypair) and decommission Jenkins.

Do not extend this directory.
