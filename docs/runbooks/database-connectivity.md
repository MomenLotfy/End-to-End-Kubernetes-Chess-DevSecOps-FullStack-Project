# Runbook: database connectivity (ChessDbPoolExhaustion / ChessDbErrorsHigh)

## 1. Symptoms

- Critical `ChessDbPoolExhaustion`: pool waiters >2 for 5m (queries queue; pool=10).
- Warning `ChessDbErrorsHigh`: sustained query failures.
- Often paired with 5xx/latency alerts (DB is the lane).

## 2. First checks

1. App-side or RDS-side? (pool waiters + fast queries = pool too small; slow queries + RDS CPU up = RDS saturated.)
2. RDS reachable at all? (DNS + TCP from a debug pod.)

## 3. Prometheus/Grafana queries

```promql
db_pool_connections
histogram_quantile(0.95, sum by (le, operation) (rate(db_query_duration_seconds_bucket[5m])))
sum by (operation) (rate(db_query_errors_total[5m]))
```

Dashboard: Database / RDS (pool, latency, errors) + CloudWatch (below).

## 4. kubectl + AWS commands

```bash
RDS=$(terraform -chdir=terraform/environments/staging output -raw rds_endpoint)
kubectl -n chess-staging run db-probe --rm -i --restart=Never --image=postgres:17-alpine \
  -- pg_isready -h "$RDS" -p 5432
aws cloudwatch get-metric-statistics --region us-east-1 --namespace AWS/RDS \
  --metric-name DatabaseConnections --dimensions Name=DBInstanceIdentifier,Value=<from-terraform-output> \
  --start-time $(date -u -d '30 min ago' +%FT%TZ) --end-time $(date -u +%FT%TZ) \
  --period 60 --statistics Average,Maximum
# Same pattern for CPUUtilization, FreeableMemory, FreeStorageSpace, ReadLatency, WriteLatency.
```

## 5. Logs to inspect

- Loki: `{namespace="chess-staging",container="backend"} | json | message=~"(?i).*(pool|query|database|postgres).*" | level=~"error|warn"`.
- RDS postgres log export (CloudWatch Logs) for FATALs, checkpoints, lock waits.
- ESO: did `chess-app` rotate to a wrong password? (`db-password` failures look like instant 100% query errors.)

## 6. Likely causes

1. Pool exhaustion: slow queries holding slots (check p95 by operation) or traffic above pool=10.
2. RDS saturated: CPU/connections/storage (CloudWatch), failover in progress.
3. Wrong credentials after rotation (100% instant failures, zero waiters).
4. NetworkPolicy/SG change blocking 5432 (never edit SGs chasing this — verify first).
5. Migration lock held (run.js advisory lock + long DDL blocks app queries behind it).

## 7. Safe remediation

- Slow-query lane: identify operation, check RDS Performance Insights top SQL, fix forward (index/query) — never manual DDL on RDS.
- Pool lane: raise `DB_POOL_MAX` ONLY with RDS headroom confirmed (connections metric); pool × pods ≤ RDS max_connections with margin.
- Credentials: fix secret value, ESO ≤5m, rollout restart backend.
- Restart the backend ONLY after the cause is addressed (restarting into a sick DB lengthens the outage).

## 8. Rollback/escalation

- App rollback does not fix DB-side issues — rollback only if a release introduced the bad query.
- Escalate: RDS-side (failover, storage full, AZ event) → platform page with CloudWatch graphs + `pg_isready` output. Storage-full is SEVEREST (RDS can stop) — treat `FreeStorageSpace` near zero as page-now.

## 9. Data/security cautions

- Never run DDL/DML by hand on RDS (forward-only migrations). Read-only `SELECT` probes only, and only when needed.
- Connection strings/credentials stay in Secrets Manager; `pg_isready` needs no password.
- Performance Insights may show query TEXT with literals — handle screenshots as sensitive.
