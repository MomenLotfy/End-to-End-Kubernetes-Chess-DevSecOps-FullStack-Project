# SRE observability model (Wave 6) — how staging is operated

Companion to `docs/security/wave6-baseline.md` (what was built) and
`docs/slo/chess-staging-slos.md` (objectives). This doc is the OPERATING
MODEL: who watches what, how incidents flow, how deploys correlate with
telemetry, what it costs, and what survives a disaster.

## 1. Operating model (staging)

| Function | Owner | Cadence | Tool |
|---|---|---|---|
| Watch burn + critical alerts | on-call (staging webhook) | continuous | Alertmanager → webhook |
| Weekly SLO/error-budget review | chess-platform | weekly | SLO doc + Grafana Overview |
| Deployment correlation check | deployer | every sync | ArgoCD history + `chess_build_info` |
| Dashboard hygiene (no ad-hoc sprawl) | chess-platform | monthly | 5 provisioned dashboards only |
| Runbook drill (one runbook) | chess-platform | monthly | `docs/runbooks/` |
| Access review (Grafana admin, webhook) | chess-platform | quarterly | Secrets Manager rotation |

Staging alerts NEVER page production channels (no prod receiver exists).
Severity policy: critical = act now (user impact or telemetry blind);
warning = same working day; info unused (no alert spam by construction).

## 2. Incident workflow (staging)

```text
alert fires → acknowledge (webhook) → open runbook by runbook_url →
triage lane (app / DB / K8s / obs / ALB) → mitigate (revert/restart/fix-forward) →
verify (alert resolves + SLO panels green) → log window + cause → weekly review
```

Rules: telemetry gaps during obs outages are unrecoverable — log the blind
window. Never paste Secrets into tickets (key names only). App rollback =
gitops digest revert; DB = forward-only; chart = chart revert (Wave 5 §M,
unchanged). OOM/heap data stays internal (runbook §9 each).

## 3. Deployment correlation (build → telemetry)

Every release is traceable in both directions without new tooling:

- App → telemetry: `chess_build_info{version,commit}` (constant 1) joins any
  query to the running digest; `up{job="backend"}` gaps mark Recreate restarts.
- Telemetry → app: ArgoCD `chess-staging` sync history (who/what/when) +
  gitops digest commits; migration Job history (`kubectl get jobs`) names the
  exact schema each deploy migrated with.
- Deployer checklist (every sync): watch Overview 10m post-sync (5xx, p95,
  restarts); any burn → digest revert first, investigate second.

## 4. Cost model (staging, us-east-1 list prices at 2026-09 — estimates)

| Item | Size/behavior | ≈ monthly cost |
|---|---|---|
| EBS gp3 Prometheus 10Gi | 10Gi + 3k IOPS baseline | ≈ $1.10 |
| EBS gp3 Loki 5Gi | 5Gi | ≈ $0.55 |
| EBS gp3 Grafana 2Gi | 2Gi | ≈ $0.25 |
| App PVC (existing, Wave 5) | 2Gi | ≈ $0.25 |
| CloudWatch logs (EKS/VPC/RDS, Wave 4) | 30d retention, low volume | ≈ $1–5 |
| CloudWatch metrics/alarms (USER-SIDE) | ~20 metrics, ~10 alarms | ≈ $5–8 |
| EBS snapshots | none scheduled (staging) | $0 |
| Data transfer (scrapes, in-AZ) | in-cluster only | $0 |
| **Wave 6 incremental total** | | **≈ $8–15/mo** |

Cost guards: bounded retention (15d/7d), ingestion caps (Loki 8MB/s),
30s scrape intervals, no cross-AZ/metric duplication, no per-pod test
traffic. Production multipliers (HA ×3, longer retention, S3 Loki) belong
to the Wave 8 sizing review — NOT extrapolated here.

## 5. Backup / recovery (staging)

| Data | System of record | Backup | Recovery | RPO/RTO accepted |
|---|---|---|---|---|
| Metrics (15d) | Prometheus TSDB (disposable) | none | resync chart; gaps unrecoverable | best-effort / 15m |
| Logs (7d) | Loki TSDB (disposable) | none | resync chart; gaps unrecoverable | best-effort / 15m |
| Grafana (sqlite, prefs) | PVC 2Gi | none (dashboards in git) | resync; UI prefs lost (by design) | n/a / 10m |
| Alertmanager silences | emptyDir | none | re-apply silences post-recovery | n/a / 5m |
| App data (RDS) | RDS automated backups + PITR (Wave 4) | AWS-managed | AWS restore (runbook: database-connectivity escalation) | per Wave 4 |
| Avatars (RWO PVC, Wave 5) | single copy (KNOWN residual) | none yet | Wave 7 S3 migration removes the risk | accepted / manual |

Rule: anything worth keeping lives in GIT (dashboards, rules, configs,
runbooks) or RDS (app data). Telemetry stores are explicitly disposable —
this is a staging cost decision, re-decided for production in Wave 8.

## 6. What "healthy" looks like (daily glance)

Grafana Overview: backend UP, frontend 2/2, 5xx ≈ 0%, p95 < 0.5s, sockets ≥
0, pool waiting = 0, restarts = 0/1h, no firing criticals in Alertmanager.
Anything else → runbook by panel/alert name. Weekly: burn rates near zero,
error budget ≥ 75%, deploy success log updated (SLO-5, manual count).
