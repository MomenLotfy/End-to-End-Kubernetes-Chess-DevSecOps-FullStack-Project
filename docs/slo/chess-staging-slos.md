# Chess staging SLOs (Wave 6) — proposed objectives, NOT measured history

These targets are DOCUMENTED OBJECTIVES until production traffic establishes
realistic baselines. Nothing here claims measured compliance — measurement
starts with the Wave 6 stack, and the first 30 days calibrate the numbers.
Owner for all staging SLOs: chess-platform (staging).

## Error-budget model

```text
SLO target → allowed bad events → remaining budget → alert thresholds → action
99% availability (30d) → 1% bad → budget = 1% × valid requests
  fast burn (>14.4x, 1h+5m) → page (ChessSLOBurnFast)
  slow burn (>6x, 6h+30m)  → investigate today (ChessSLOBurnSlow)
```

Budgets inform RELEASE decisions (freeze risky deploys when <25% remains),
not scores. Staging budgets never page production channels.

## SLO-1: HTTP API availability

- service: chess-backend (staging) · indicator: non-5xx responses
- numerator: `sum(rate(http_requests_total{status_class!~"5xx|other"}[30d]))`
- denominator: `sum(rate(http_requests_total[30d]))`
- target: 99% · window: rolling 30d · exclusions: planned ArgoCD syncs
  (Recreate restart ≈30s), load-test traffic (labeled), CloudWatch-side
  incidents (RDS/ALB/EKS outages count against AWS, noted not hidden)
- alert: ChessSLOBurnFast/Slow + ChessHigh5xxRate · runbook: high-5xx.md

## SLO-2: API latency (successful requests)

- service: chess-backend · indicator: p95 of 2xx/3xx request duration
- numerator: `histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket{status_class=~"2xx|3xx"}[5m])))`
- denominator: n/a (threshold SLO) · target: p95 < 1.5s · window: 5m
  evaluated continuously (breach = 10m sustained)
- exclusions: cold starts after deploy (5m), RDS failover windows
- alert: ChessHighLatency (warning) · runbook: high-latency.md

## SLO-3: 5xx error rate (duplicate lens on SLO-1 for paging)

- Covered by SLO-1's numerator; operationalized separately because pages key
  on RATIO not availability: `api:http_error_ratio5m > 5%` for 5m pages
  (ChessHigh5xxRate). Same runbook, faster trigger than burn windows.

## SLO-4: WebSocket connection health

- service: Socket.io (staging) · indicator: accepted / (accepted + rejected)
- numerator: `sum(rate(socket_io_connects_total[1h]))`
- denominator: numerator + `sum(rate(socket_io_auth_failures_total[1h]))`
- target: 99% · window: 1h rolling · exclusions: mass deploy disconnects
  (clients reconnect), proven credential-stuffing floods (counted as security
  events, still investigated)
- alert: ChessSocketAuthFailuresHigh (rate proxy; ratio alert lands after
  baseline) · runbook: high-5xx.md (socket section)

## SLO-5: Deployment success

- service: delivery pipeline · indicator: ArgoCD syncs reaching Healthy
  without manual rollback
- numerator/denominator: manual count from ArgoCD history (no metric yet —
  honest gap; Wave 8 automates via ArgoCD notifications)
- target: ≥95% of staging syncs Healthy first-try · window: 30d
- exclusions: intentional reverts, infra-experiment syncs
- alert: none automated (reviewed weekly) · runbook: release runbook (Wave 5)

## SLO-6: Database connectivity/availability

- service: chess-backend → RDS · indicator: pool waiters + query errors
- numerator: time with `db_pool_connections{state="waiting"} == 0` AND
  `rate(db_query_errors_total[5m]) == 0`
- denominator: total time · target: 99.5% · window: 30d
- exclusions: RDS maintenance windows (AWS-notified), migration windows
  (locks are intentional)
- alert: ChessDbPoolExhaustion (critical), ChessDbErrorsHigh (warning) ·
  runbook: database-connectivity.md
- RDS-native truth (CloudWatch `DatabaseConnections`, failover events)
  stays authoritative for AWS-side attribution.
