# Runbook: pod crash loop (ChessPodCrashlooping / ChessPodRestartingRepeatedly)

## 1. Symptoms

- Critical `ChessPodCrashlooping`: container in CrashLoopBackOff for 5m (namespace/pod in labels).
- Or warning `ChessPodRestartingRepeatedly`: >5 restarts in 1h.

## 2. First checks

1. WHICH pod? (app vs obs stack — obs restarts go to observability-stack-failure.md after triage.)
2. Crash reason: `describe` lastState (Error vs OOMKilled → oom-kill.md).

## 3. Prometheus/Grafana queries

```promql
kube_pod_container_status_waiting_reason{namespace=~"chess-.*",reason="CrashLoopBackOff"}
sum by (pod) (increase(kube_pod_container_status_restarts_total{namespace=~"chess-.*"}[1h]))
kube_pod_container_status_last_terminated_reason{namespace=~"chess-.*"}
```

Dashboard: Kubernetes / Workloads (restarts, unavailable panels).

## 4. kubectl commands

```bash
POD=<pod-from-alert>   # e.g. chess-backend-7f9c8b6d4-x2kqz
kubectl -n chess-staging describe pod $POD | grep -A12 "Last State"
kubectl -n chess-staging logs $POD -p --tail=150   # previous container = crash reason
kubectl -n chess-staging get events --field-selector involvedObject.name=$POD | tail -10
```

## 5. Logs to inspect (Loki + previous container)

- Previous-container logs FIRST (`-p`): startup FATALS (JWT/DB/SMTP validation), migration-gate errors, OOM stdout tail.
- Loki `{namespace="chess-staging",pod="<pod>"} | json | level="error"` for the pre-crash minute.

## 6. Likely causes

1. Config/secret invalid: FATAL at boot (placeholder JWT, missing DB_*, bad FRONTEND_URL).
2. Migration gate: backend boot requires 007 row (migration Job failed/skipped).
3. Bad image (digest typo, ECR pull ok but crash on start).
4. Liveness killing a slow starter (check `initialDelaySeconds` vs actual boot time).
5. OOMKilled (lastState reason) → oom-kill.md, not here.

## 7. Safe remediation

- Config: fix the value in git (chart) or Secrets Manager (ESO ≤5m), let ArgoCD sync; never `kubectl edit` (selfHeal reverts).
- Image: revert digest commit in gitops.
- Migration gate: fix Job per migration-failure.md, then delete the CrashLoop pod to retry boot (Deployment recreates it).
- Do NOT scale or delete the Deployment to "stop the noise" — fix the cause.

## 8. Rollback/escalation

- Rollback = digest/chart revert (same as backend-unavailable §8).
- Escalate: crash persists after revert + secret verification → platform page with previous-container logs + describe output.

## 9. Data/security cautions

- Crash logs may include env-var NAMES (never values — values come from Secrets, not the environment listing). Still, redact before pasting externally.
- Deleting pods drops in-memory Socket.io rooms (backend) — expected, recovers from DB.
