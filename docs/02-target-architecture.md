# Phase 2 — Target Architecture (2026 production)

> **Gate status (2026-09-22):** this document is the proposal; `docs/05-architecture-gate.md`
> is the reviewed decision record and `docs/adr/001–010` freeze the rulings. Deltas applied by
> the gate: OTel SDK explicitly deferred (trace-ready only); Falco rejected → GuardDuty EKS
> Protection; RDS Proxy / CloudFront / cross-region replication deferred with triggers;
> GitOps = separate `chess-gitops` repo + commit-back (no Image Updater); Kyverno ≤5 policies,
> audit-first; scale-out isolated as Wave 7 Scale-Out Gate (the only app-behavior wave).

## 2.1 Principles

Immutable artifacts, IaC-only infra, GitOps promotion, ephemeral PR envs (compose-based, not
EKS-per-PR — cost), automated security gates, least privilege, zero-trust where cheap (mTLS
deferred; NetworkPolicy + TLS everywhere now), centralized logs/metrics, automated rollback,
reproducible builds (pinned, SBOM, provenance).

## 2.2 Environment progression

| Env | Runs on | Purpose | Data |
|---|---|---|---|
| Development | laptop, `docker compose` + dev override | fast loop, Mailpit | synthetic |
| Testing (CI) | GitHub Actions + compose profiles | unit/integration/e2e, scans | synthetic `*_test` DBs |
| Staging | EKS (small node group) via ArgoCD `staging` | prod-like: RDS, TLS, ESO, monitoring | sanitized subset, refreshed periodically |
| Production | EKS (2 AZ min) via ArgoCD `prod` | live traffic | real, backed up, encrypted |

Promotion: image digest `staging` → soak + e2e → promote same digest to `prod`. Never rebuild
between envs. Never `latest`.

## 2.3 Decisions (what we use and why — anti-sprawl)

| Decision | Choice | Rationale |
|---|---|---|
| App hosting (now) | keep single-server Compose | app is 1-replica by design; Compose is the correct production runtime until Redis phase |
| App hosting (later) | EKS + Helm chart, backend `replicas: 1`, `Recreate` | HA at cluster level; app-level HA unlocked only by Redis adapter phase |
| DB on AWS | RDS Postgres 16 (Multi-AZ in prod) | backups, PITR, KMS, Enhanced Monitoring; no in-cluster Postgres on EKS |
| Cache/sessions | none now; ElastiCache Redis (t4g.micro) only with adapter phase | no current need; don't pay for idle Redis |
| Registry | ECR (private, immutable tags, lifecycle policy, scan-on-push) | native IAM/OIDC, no Docker Hub rate/pull-secret pain |
| CI | GitHub Actions (primary) | already connected, OIDC-ready; Jenkins **retired** unless a hard requirement appears (see §2.4) |
| CD | ArgoCD App-of-Apps (`staging`, `prod`) + image-updater or commit-back | declarative, auditable, auto-sync+self-heal in staging, manual promotion to prod |
| IaC | Terraform modules (`vpc/eks/rds/redis/ecr/iam/acm/route53`) + envs (`dev/staging/prod`) | remote state S3 + DynamoDB lock, per-env state keys |
| Config mgmt | Ansible only for: bastion/ops host, single-server hardening, nginx-on-host (if ever), node ops agents | everything else is Terraform (infra) or K8s manifests (workloads) |
| Ingress | AWS LB Controller (ALB) + ACM TLS + Route53 | managed TLS, WAF-ready; nginx stays as frontend sidecar pattern only in compose |
| Secrets | Secrets Manager + External Secrets Operator → K8s Secrets (encrypted at rest via KMS) | rotation + audit; plain K8s Secrets only as ESO-synced targets |
| Policy | Kyverno (1–2 policies to start: require probes+limits, block `:latest`/privileged) | simpler than Gatekeeper for this size; expand only on need |
| Observability | kube-prometheus-stack + Loki + Grafana Alloy (single collector) | one agent for logs+metrics; OTel SDK only if tracing justified (likely phase 2: low — 2-service app; keep trace-ready headers, defer sampler) |
| Tracing | **deferred** | 2-hop app; logs+metrics suffice. Revisit when Redis/workers/queues land |
| SBOM/signing | Syft SBOM + Cosign keyless (Fulcio/Rekor) in release workflow | supply-chain proof without key management |
| SAST/DAST | CodeQL (or Semgrep) SAST in CI; DAST deferred to staging OWASP ZAP baseline | DAST against prod-like staging only, not PRs |

## 2.4 Jenkins ruling

**Retire Jenkins as the default path.** GitHub Actions + OIDC covers build/test/scan/push; ArgoCD
covers deploy. A self-hosted Jenkins (`t3.2xlarge`, public SG, plugin maintenance, credential
sprawl) adds cost and attack surface with no capability gain for this repo. Keep one maintained
`Jenkinsfile` only if the organization mandates Jenkins — responsibilities then: Jenkins = build
agents for heavyweight jobs; GitHub Actions = gates; ArgoCD = deploy. Never both owning deploy.

## 2.5 Data & availability targets (initial, honest)

- RPO ≤ 24h (daily RDS snapshots + WAL/PITR 7d in prod), RTO ≤ 4h (terraform + ArgoCD sync +
  restore runbook). Tighten after first DR drill.
- SLOs (prod): availability 99.5% monthly (single-AZ staging excluded), p95 latency < 400ms on
  `/api/*` (excl. WS), 5xx rate < 0.5%. Alerts only on SLO burn + crashloops + cert expiry +
  DB failover + deploy failure.
- Scaling: frontend HPA 2–6 (CPU 70%); backend fixed 1 (documented); Postgres = RDS autoscaling
  storage; uploads migrate to S3 + CloudFront in the EKS phase (volume → object storage ADR).

## 2.6 Cost posture (us-east-1, rough 2026)

Keep staging small (1× `t3.medium` node group, single-AZ RDS `db.t4g.micro`, 1 NAT).
Prod: 2× `t3.medium`+ (or Graviton `m7g` after test), Multi-AZ `db.t4g.small`, 1 NAT/AZ.
Largest levers: NAT Gateway hours (~$32/mo each + data), RDS Multi-AZ, ALB hours, EKS control
plane ($73/mo). No CloudFront until traffic justifies; no ElastiCache until Redis phase.
