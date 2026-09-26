# Runbook: high latency (ChessHighLatency / ChessCPUSaturation)

## 1. Symptoms

- Warning `ChessHighLatency`: API p95 >1.5s for 10m.
- Sluggish UI, slow moves; may precede 5xx (timeouts) — treat as pre-incident.

## 2. First checks

1. p50 high too (systemic) or only p99 (tail: single slow dependency)?
2. CPU saturated? Event-loop lag? DB slow? (pick the lane in 60s.)

## 3. Prometheus/Grafana queries

```promql
api:http_latency_p95_5m
histogram_quantile(0.50, sum by (le) (rate(http_request_duration_seconds_bucket[5m])))
eventloop_lag_seconds
histogram_quantile(0.95, sum by (le, operation) (rate(db_query_duration_seconds_bucket[5m])))
sum by (pod) (rate(container_cpu_usage_seconds_total{namespace="chess-staging",pod=~"chess-backend.*"}[5m]))
```

Dashboard: Chess Backend / API (latency, in-flight + lag, DB p95 panels).

## 4. kubectl commands

```bash
kubectl -n chess-staging top pod -l app.kubernetes.io/name=backend
kubectl -n chess-staging get pod -l app.kubernetes.io/name=backend -o wide   # which node? noisy neighbor?
kubectl -n chess-staging logs deploy/chess-backend --since=10m | grep -i "slow\|timeout" | tail -20
```

## 5. Logs to inspect (Loki)

- Slow-query hints: backend warn/error around pool waits.
- RDS postgres logs (CloudWatch `/aws/rds/.../postgresql`) for lock waits / checkpoints during the window.

## 6. Likely causes

1. CPU throttling at the 1-core limit (usage/limit >0.9, lag rising).
2. DB slow: RDS CPU/connections saturated, long transactions, missing index on a hot route.
3. Event-loop blocked: large JSON payloads, chess.js search paths, GC pressure (memory near limit).
4. Noisy neighbor / node CPU pressure (single-node staging pool).

## 7. Safe remediation

- Confirm the lane FIRST (CPU vs DB vs loop) — do not raise limits blindly.
- CPU: temporary limit raise via chart values (reviewed commit) if throttled AND p50-correlated.
- DB: see database-connectivity.md (RDS metrics, kill runaway from application side by restart only as last resort).
- Deploy-related: wait out post-deploy cold start (5m exclusion) before acting.

## 8. Rollback/escalation

- Latency from a new release: digest revert.
- Escalate: p95 >5s for 20m with no clear lane → platform page with p50/p95/p99 + top-route table + `kubectl top` output.

## 9. Data/security cautions

- `EXPLAIN` slow queries against staging ONLY with redacted literals; never copy user data into tickets.
- Limit raises increase cost and OOM headroom needs — pair CPU raises with a memory review.
