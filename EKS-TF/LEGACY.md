# LEGACY / NON-AUTHORITATIVE — do not use for new work

This directory (`EKS-TF/`) is the PRE-Wave-4 Terraform for the old public-subnet
EKS cluster. It is kept for reference only until the new foundation
(`terraform/`, Wave 4) + GitOps path (Wave 5) are proven, then it will be
archived.

Known deficiencies (see `docs/security/wave4-baseline.md` §A for the full audit):

- worker nodes + cluster live in PUBLIC subnets (`map_public_ip_on_launch`)
- single shared security group (`Jenkins-sg`) for everything
- no private subnet architecture, no NAT design, no RDS (postgres runs in-cluster)
- no IRSA / OIDC workload identity
- EKS API publicly reachable without CIDR restriction
- DynamoDB state-locking pattern (deprecated since Terraform 1.11)

Authoritative infrastructure: `terraform/environments/staging` (+ `production`
planned). Do not extend this directory.
