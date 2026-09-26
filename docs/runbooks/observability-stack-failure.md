# Runbook: observability stack failure (Alloy/Loki/Prometheus/Alertmanager)

## 1. Symptoms

- Critical `ChessAlloyDown` (no healthy Alloy), `ChessMetricsPipelineStale`
  (backend/KSM series absent), `ChessLokiDown`; warning `ChessAlertmanagerDown`.
- Grafana gaps/empty panels; alerts stop arriving (Alertmanager) or stop evaluating (Prometheus).

## 2. First checks

1. Which component? (`up{job="..."}` per job tells you in one query.)
2. App impact? (Observability NEVER affects app availability — backend stays up. Confirm, then fix calmly.)

## 3. Prometheus/Grafana queries

```promql
up{job=~"prometheus|alloy|loki|alertmanager|grafana|backend|kube-state-metrics|kubelet"}
count by (job) (up{job=~"backend|kube-state-metrics|kubelet"})   # expect 1; >1 = Alloy clustering failed
rate(prometheus_remote_storage_failed_samples_total[5m])
prometheus_rule_evaluation_failures_total
```

## 4. kubectl commands

```bash
kubectl -n chess-observability get pods -o wide
kubectl -n chess-observability logs daemonset/alloy --tail=80 | grep -i "error\|failed" | tail -20
kubectl -n chess-observability logs statefulset/prometheus --tail=60
kubectl -n chess-observability logs statefulset/loki --tail=60
kubectl -n chess-observability logs deploy/alertmanager --tail=40
kubectl -n chess-observability get events --sort-by=.lastTimestamp | tail -15
```

## 5. Logs to inspect

- Alloy DaemonSet logs (scrape errors, remote-write failures, cluster membership).
- Prometheus logs (rule-load errors, remote-write receiver rejections, TSDB corruption panics).
- Loki logs (ingestion rejections: rate limits, out-of-order, too many streams).

## 6. Likely causes

1. Alloy crash/misconfig (bad River after a chart change — ArgoCD shows the diff).
2. Loki PVC full (5Gi, 7d retention — ingestion spike?) or compactor wedged.
3. Prometheus PVC full (10Gi, 15d) or rule-file syntax error (evaluation failures).
4. Alertmanager config invalid (ESO template rendered bad YAML — check the Secret SHAPE, not the URL).
5. Clustering split: `count by (job)(up)` > 1 per job = duplicate ingestion (see §7 fallback).
6. ESO secret missing (`chess-observability` not synced → Grafana CrashLoop, Alertmanager crash).

## 7. Safe remediation

- Config-caused: revert the chart commit (ArgoCD resyncs); pods recycle.
- PVC full: retention is bounded — check for a runaway series/label explosion FIRST (`topk(10, count by (__name__)({__name__=~".+"}))`), then (only if legit growth) raise storage via values + resync (expansion allowed, no data loss).
- Clustering failure FALLBACK (documented): comment Alloy's three `prometheus.scrape` blocks, uncomment the FALLBACK jobs in prometheus.yml, resync; file a bug with `count by (job)(up)` output.
- Rule syntax: `promtool check rules` locally before committing (USER-SIDE until CI gains promtool).

## 8. Rollback/escalation

- Rollback = revert the obs chart commit in the app repo (ArgoCD resyncs previous stack). Telemetry gaps during the outage are unrecoverable (no backfill) — note the window in the incident log.
- Escalate: TSDB corruption (Prometheus won't start, WAL errors) → platform page; recovery may mean wiping `/prometheus` (15d metrics lost, accepted for staging — get explicit approval first).

## 9. Data/security cautions

- Never print ESO secrets while debugging (`describe externalsecret` shows SHAPE; `get secret -o yaml` shows VALUES — avoid the latter).
- Loki holds 7d of logs incl. error stacks — treat query screenshots as internal.
- Alertmanager silence/restarts drop silences (emptyDir) — re-apply after recovery if an incident is ongoing.
