# ADR-010 — EKS production architecture

- Status: accepted (staging first; prod gated on Wave 7 evidence + Wave 8 checklist)
- Date: 2026-09-22
- Deciders: platform review (gate)
- Related: docs/05-architecture-gate.md §2, §7; ADR-001..009

## Context

Target: VPC (2 AZ, public/private, NAT), ALB + ACM + Route53, EKS (managed nodes, IRSA),
RDS, ElastiCache (Wave 7), ECR, S3 avatars, Secrets Manager + ESO, KMS, CloudTrail, GuardDuty.
This supersedes the legacy flat `EKS-TF/` (public-only nodes, reused Jenkins SG, no IRSA/RDS).

## Problem

Is EKS the right end state for a 2-service app, and in what order is it safe to build?

## Options considered

1. **EKS as end state, staging-first** — declarative platform, team/tenant scaling, managed planes.
2. **Compose + standby host as end state** — cheapest correct HA-ish (~active/passive + DNS),
   but imperative ops forever; team velocity caps early.
3. **ECS/Fargate instead of EKS** — less K8s burden, but splits the GitOps/policy/observability
   story the team is standardizing on (ArgoCD, Kyverno, Prometheus all assume K8s).

## Decision

Option 1, sequenced: Terraform modules+envs → staging EKS+RDS (Wave 4) → chart+GitOps+ArgoCD
(Wave 5) → observability (Wave 6) → scale-out proven on staging (Wave 7) → prod EKS/RDS +
enforce + cutover (Wave 8). Nodes: AL2023 managed group, private subnets; controllers via IRSA
(ALB controller, ESO, CloudWatch agent). Cost controls: staging-small defaults (1 NAT, single-AZ
RDS), prod 2 AZ, no CloudFront/Proxy/replication until triggers fire.

## Consequences

- Positive: reproducible, auditable, autoscaling platform; staging↔prod parity; clear DR story
  (Terraform + GitOps + snapshots).
- Negative: control-plane + NAT + Multi-AZ RDS are the dominant bill; upgrades/add-ons are real
  toil (budgeted: quarterly EKS maintenance window).

## Migration implications

Legacy `EKS-TF/` archived after Wave 5 (not deleted silently). Prod cutover is weighted DNS with
Compose fallback retained 30 days. First DR drill rebuilds staging from scratch (Wave 8) before
prod is declared done.
