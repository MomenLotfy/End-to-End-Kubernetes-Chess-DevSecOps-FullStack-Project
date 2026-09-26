# chess Helm chart (AUTHORITATIVE for EKS staging)

The only supported way to run chess on Kubernetes. Legacy `Manifest-file/`
is NON-AUTHORITATIVE (see its `LEGACY.md`) and is never deployed by CI.

## Value layers (later wins)

| # | File | Repo | Holds |
|---|---|---|---|
| 1 | `values.yaml` | app | safe shared defaults (fail-closed: empty digests/hosts) |
| 2 | `values-staging.yaml` | app | portable staging flavor (no identity, no wiring) |
| 3 | GitOps `apps/chess/staging/images.yaml` | **gitops (separate)** | `global.registry` + 3 image digests (commit-back target) |
| 4 | GitOps `apps/chess/staging/wiring.yaml` | **gitops (separate)** | RDS host, origins, ACM ARN, ingress host, CIDRs, secret ARNs |

ArgoCD renders with all four (`valueFiles`). `helm template` locally needs
layers 3–4 supplied (use clearly-fake values — never invent real digests):

```bash
helm lint deploy/helm/chess
helm template chess-staging deploy/helm/chess \
  -f deploy/helm/chess/values-staging.yaml \
  --set global.registry=000000000000.dkr.ecr.us-east-1.amazonaws.com \
  --set backend.image.digest=sha256:aaa... \
  ... | kubeconform -strict -summary
```

## Traffic matrix

| Source | Destination | Port | Enforced by |
|---|---|---|---|
| Internet | ALB | 443 (80→redirect) | ALB SG (auto-managed, documented) |
| ALB (VPC CIDR) | frontend pods | 8080 | NetworkPolicy `allow-frontend-ingress` |
| nodes (app subnets) | pods | 8080/5000 | NetworkPolicy (kubelet probes) |
| frontend pods | backend `chess-backend` | 5000 | NetworkPolicy `allow-backend-ingress` |
| Alloy pods (`chess-observability`) | backend `chess-backend` | 5000 (`/metrics`) | NetworkPolicy `allow-backend-ingress` §3b (Wave 6, ns+pod scoped) |
| backend/migration | RDS | 5432 TLS | RDS SG (EKS cluster SG only, Terraform) |
| backend | Valkey (ElastiCache serverless) | 6379 TLS+AUTH | ElastiCache SG (EKS cluster SG only, Terraform, Wave 7) |
| ESO controller | Secrets Manager | 443 | IRSA role (4 secrets: +redis in Wave 7) |
| pods | DNS | 53 | open egress (documented conservative scope) |

## Secrets flow (no plaintext anywhere in Git)

```text
RDS-managed secret ──ESO──▶ Secret chess-db-master ──▶ migration Job (master)
chess/staging/app  ──ESO──▶ Secret chess-app ──▶ backend (app user + JWT + SMTP + origins + CA)
```

Owner creates `chess/staging/app` ONCE (JSON keys documented in
`docs/security/wave5-baseline.md` runbook step 3) BEFORE the first sync.

## Known staging behaviors

- Backend strategy is **Recreate** (single replica + RWO uploads PVC cannot
  RollingUpdate — a surge pod could never attach the volume). Brief downtime
  per deploy; Wave 7 (S3 + Redis) removes it.
- Rotated secrets need a pod restart (no reloader in Wave 5, by design).
- Egress NetworkPolicy is intentionally absent (VPC CNI has no FQDN
  selectors); the RDS security group remains the data-plane enforcement point.
- Frontend nginx runs the K8s overlay (`configmap-frontend-nginx.yaml`):
  plain-HTTP 8080 serve; TLS terminates at the ALB. Delta vs the baked
  compose config is documented in the template and parity-checked by
  `scripts/wave5-static-checks.py`.
