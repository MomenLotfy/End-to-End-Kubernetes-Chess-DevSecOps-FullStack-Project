# Runbook: high 5xx (ChessHigh5xxRate / ChessSLOBurnFast / ChessSLOBurnSlow)

## 1. Symptoms

- Critical `ChessHigh5xxRate`: 5xx ratio >5% for 5m, or SLO burn alerts.
- Users see "Internal server error" / failed actions; login may work (401s are 4xx, not this).

## 2. First checks

1. Which ROUTES? (one route = code/query bug; all routes = DB/infra.)
2. Started when? (correlate with last ArgoCD sync / migration.)

## 3. Prometheus/Grafana queries

```promql
api:http_error_ratio5m
sum by (route) (rate(http_requests_total{status_class="5xx"}[5m]))
sum by (component) (rate(app_errors_total[5m]))
sum by (operation) (rate(db_query_errors_total[5m]))
```

Dashboard: Chess Backend / API (4xx/5xx, App errors, DB errors panels).

## 4. kubectl commands

```bash
kubectl -n chess-staging get pods -l app.kubernetes.io/name=backend
kubectl -n chess-staging logs deploy/chess-backend --since=15m | grep -i error | tail -30
kubectl -n chess-staging top pod -l app.kubernetes.io/name=backend   # needs metrics-server
argocd app history chess-staging | head -5   # what synced when (or ArgoCD UI)
```

## 5. Logs to inspect (Loki)

- `{namespace="chess-staging",container="backend"} | json | level="error"` — stack traces name the route + error.
- Auth-flavored 5xx? Check `{...} | json | message=~"(?i).*auth.*" | level="warn"`.
- Socket section (SLO-4): `socket_io_auth_failures_total` rate + `logger.warn("Socket authentication rejected")` lines.

## 6. Likely causes

1. Single route 5xx: code bug or slow/failing query behind that route.
2. All routes 5xx: DB down/saturated (pool waiters >0, query errors up) → database-connectivity.md.
3. Post-deploy 5xx: migration partially applied / 007-gate confusion (readiness flapping + Recreate restarts).
4. Upstream: RDS failover/maintenance (CloudWatch events), ESO secret rotation with wrong value (JWT/DB).

## 7. Safe remediation

- DB-backed: fix DB side first (never restart-loop the backend into a sick database).
- Bad release: revert digest commit in gitops (app rollback, §M Wave 5 baseline).
- Bad secret value: fix in Secrets Manager, wait ≤5m ESO refresh, `rollout restart deploy/chess-backend`.

## 8. Rollback/escalation

- Rollback = digest revert (fast, no rebuild). Forward DB fixes only (never manual DDL).
- Escalate: 5xx persists 15m after revert → platform page with: top-5xx-route query output, error-log sample (redacted), last sync ID.

## 9. Data/security cautions

- Error stacks may contain SQL fragments — fine to keep, never contains credentials (pool errors log messages only).
- Do not enable query-parameter logging to "debug faster" (PII risk); use route + operation labels instead.
