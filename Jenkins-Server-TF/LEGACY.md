# LEGACY / NON-AUTHORITATIVE — do not use for new work

This directory (`Jenkins-Server-TF/`) provisions the retired Jenkins EC2 server
and its VPC. It is kept for reference only until the new foundation
(`terraform/`, Wave 4) + GitOps path (Wave 5) are proven, then archived.

Known deficiencies (see `docs/security/wave4-baseline.md` §A for the full audit):

- single public subnet; SSH (22), Jenkins (8080) and SonarQube (9000) open to
  `0.0.0.0/0`
- single shared security group reused by EKS (`EKS-TF/` reads `Jenkins-sg`)
- static SSH key-pair variable (`your-key-name` placeholder)
- overly broad inline IAM (incl. `Resource: "*"` EKS/ECR/EC2/IAM statements and
  security-group mutation rights on the shared SG)
- DynamoDB state-locking pattern (deprecated since Terraform 1.11)
- Jenkins itself is retired (ADR-006: GitHub Actions is the CI system)

Authoritative infrastructure: `terraform/`. Do not extend this directory.
