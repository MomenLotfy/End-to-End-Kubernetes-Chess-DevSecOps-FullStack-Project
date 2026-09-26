# Runbook: backend unavailable (ChessBackendDown / ChessFrontendDown)

## 1. Symptoms

- Alert `ChessBackendDown` (critical): `up{job="backend"} == 0` for 2m.
- Or `ChessFrontendDown`: zero available `chess-frontend` replicas (ALB 5xx).
- Users see failed logins/moves; Grafana "Chess Platform Overview" shows DOWN.

## 2. First checks (60 seconds)

1. Is the POD down or just the METRICS path? (`up==0` covers both.)
2. Scope: backend only, or frontend too? (`ChessFrontendDown` firing = wider.)

## 3. Prometheus/Grafana queries

```promql
up{job="backend"}
kube_deployment_status_replicas_available{deployment="chess-backend",namespace="chess-staging"}
kube_pod_container_status_waiting_reason{namespace="chess-staging",pod=~"chess-backend.*"}
increase(kube_pod_container_status_restarts_total{namespace="chess-staging",pod=~"chess-backend.*"}[15m])
```

Dashboard: Chess Platform Overview (Backend up, Frontend replicas, Restarts).

## 4. kubectl commands

```bash
kubectl -n chess-staging get deploy chess-backend chess-frontend
kubectl -n chess-staging get pods -l app.kubernetes.io/name=backend -o wide
kubectl -n chess-staging describe pod -l app.kubernetes.io/name=backend | tail -40
kubectl -n chess-staging logs deploy/chess-backend --tail=100
kubectl -n chess-staging logs deploy/chess-backend --tail=100 -p   # previous (crashed) container
kubectl -n chess-staging get events --sort-by=.lastTimestamp | tail -20
```

## 5. Logs to inspect (Loki)

- `{namespace="chess-staging",container="backend"} | json | level="error"` (fatal startup? migration gate?)
- Dashboard "Logs / Errors" → Backend errors panel.
- CrashLoop: `kubectl logs -p` (previous container) — Loki may lack it if Alloy lagged.

## 6. Likely causes

1. CrashLoopBackOff (bad image/config) — check restarts + previous logs.
2. Readiness never green: migration 007 row missing (migration Job failed?) or `startupReady` false (DB unreachable at boot).
3. ImagePullBackOff (ECR/credential/digest typo in gitops `images.yaml`).
4. FailedScheduling (no capacity) / FailedMount (PVC/secret missing — ESO not synced?).
5. Alloy down (pod healthy but unscraped) — see observability-stack-failure.md.

## 7. Safe remediation

- CrashLoop/config: fix forward in git (chart or app), let ArgoCD sync; do NOT edit the Deployment in place (selfHeal reverts you).
- Readiness/DB: see database-connectivity.md; restart AFTER the cause is fixed: `kubectl -n chess-staging rollout restart deploy/chess-backend`.
- Image pull: verify digest in gitops `images.yaml` matches a real ECR digest; revert the digest commit if bogus.
- ESO secret missing: `kubectl -n chess-staging get externalsecret` → check Ready + events; fix SecretStore/secret, ESO re-syncs ≤5m.

## 8. Rollback/escalation

- Bad release: `git revert` the digest commit in `chess-gitops` (previous image redeploys, ≈1 Recreate restart). Bad chart: revert chart commit.
- Escalate: backend still CrashLooping after revert → page platform (possible RDS/cluster incident); capture `describe`, previous logs, events first.

## 9. Data/security cautions

- Never paste Secret contents into chat/tickets; describe by key name only.
- `rollout restart` drops Socket.io connections (single replica, in-memory rooms) — warn users; rooms rebuild from DB (`rebuildActiveRooms`).
- Do not delete the uploads PVC chasing a backend issue (data loss).
