# Telemetry catalog (Wave 6) — the contract between app, Alloy, Prometheus, Loki

Source of truth for metric names (mirrors `Chess-Backend/src/metrics/` —
the Wave 6 static checks assert the two agree) and log fields. Anything not
listed here must not be queried in dashboards/alerts without a catalog update.

## Metric naming

Standard Prometheus style, no `chess_` prefix except build identity (single
app, hand-rolled client — collisions impossible). Units in base form
(`_seconds`, `_bytes`, `_total`).

## Application metrics (`job="backend"`, scraped by Alloy from `:5000/metrics`)

| Metric | Type | Labels | Meaning | Cardinality |
|---|---|---|---|---|
| `http_requests_total` | counter | method (≤5), route (~35 patterns), status_class (5) | completed requests | ≤ ~900 series |
| `http_request_duration_seconds` | histogram | method, route, status_class (11 buckets) | request latency | ≤ ~10k series (bounded by route table) |
| `http_requests_in_flight` | gauge | — | concurrent requests | 1 |
| `http_request_size_bytes` | histogram | method, route (6 buckets) | Content-Length observed | ≤ ~1k |
| `app_errors_total` | counter | component ∈ {http, db} + future {mail, socket} | uncaught/dependency errors | ≤ 4 |
| `process_uptime_seconds` | gauge | — | process age | 1 |
| `eventloop_lag_seconds` | gauge | — | 1s-tick delay | 1 |
| `db_pool_connections` | gauge | state ∈ {total, idle, waiting} | pg pool stats (pool=10) | 3 |
| `db_query_duration_seconds` | histogram | operation (15 verbs + OTHER) | query latency | ≤ 176 |
| `db_query_errors_total` | counter | operation | failed queries | ≤ 16 |
| `socket_io_connects_total` | counter | — | accepted sockets | 1 |
| `socket_io_disconnects_total` | counter | reason (7 + other) | disconnects | 8 |
| `socket_io_auth_failures_total` | counter | — | rejected handshakes | 1 |
| `socket_io_connections_active` | gauge | — | live sockets | 1 |
| `socket_io_rooms_active` | gauge | — | in-memory rooms | 1 |
| `room_operation_failures_total` | counter | — | failed room ops | 1 |
| `s3_operations_total` | counter | operation ∈ {put, get, delete}, result ∈ {ok, missing, error} | avatar object ops (Wave 7) | 9 |
| `s3_operation_duration_seconds` | histogram | operation (8 buckets) | S3 op latency | ≤ 24 |
| `s3_legacy_fallback_reads_total` | counter | — | reads served from local legacy store (Wave 7 migration window) | 1 |
| `redis_client_errors_total` | counter | client ∈ {adapter-pub, adapter-sub, store} | Redis client errors (Wave 7 P3) | 3 |
| `redis_connected` | gauge | client (same 3) | client ready state, scrape-sampled | 3 |
| `redis_reconnects_total` | counter | client (same 3) | reconnect attempts (storm visibility) | 3 |
| `redis_command_duration_seconds` | histogram | client, command (8 + OTHER, 9 buckets) | command latency | ≤ 243 |
| `rematch_redis_errors_total` | counter | operation ∈ {add, remove, clear} | failed rematch Redis ops | 3 |
| `room_hydrations_total` | counter | outcome ∈ {created, refreshed, not_found, invalid, error} | room cache hydration/refresh outcomes (Wave 7 P4) | 5 |
| `presence_checks_total` | counter | outcome ∈ {ok, failed} | cross-replica presence query outcomes (fail closed) | 2 |
| `rate_limit_degraded_total` | counter | limiter ∈ {global, login, register, resend-verification, forgot-password, reset-password, refresh} | failed limiter Redis commands; each failed request fails open (Wave 7 P5) | 7 |
| `shutdown_state` | gauge | — | lifecycle state: 0 RUNNING, 1 DRAINING, 2 STOPPING, 3 STOPPED (Wave 7 P6) | 1 |
| `shutdown_rejected_total` | counter | source ∈ {http, socket, room} | work refused while draining (Wave 7 P6) | 3 |
| `shutdown_phase_total` | counter | phase ∈ {settle, http, room, socket, cache, pg}, result ∈ {completed, timeout, forced} | drain phases by outcome (Wave 7 P6) | ≤ 18 |
| `shutdown_signals_total` | counter | signal ∈ {SIGTERM, SIGINT}, action ∈ {accepted, ignored} | shutdown triggers by action (Wave 7 P6) | 4 |
| `chess_build_info` | gauge | version, commit | build identity (=1) | 1 per deploy |

Route labels are Express PATTERNS (`/api/game/:id`), never raw paths;
404s collapse to `unmatched`. Registry-enforced: identity/PII label NAMES
(user, email, socket, game, token, ip, path…) throw at creation; values
capped at 128 chars. `/metrics`, `/liveness`, `/readiness`, `/health` are
excluded from access metrics (no self-scrape loop), as is the internal
preStop trigger `/internal/enter-drain` (Wave 7 P6 — drain plumbing must
never count as application work).

## Kubernetes metrics

| Source | Job | Series used | Notes |
|---|---|---|---|
| kube-state-metrics (static, via Alloy) | `kube-state-metrics` | `kube_deployment_*`, `kube_pod_*`, `kube_job_*`, `kube_pod_container_resource_*` | object state; no secrets |
| kubelets (node discovery, via Alloy) | `kubelet` | `container_cpu_*`, `container_memory_*`, `kubelet_volume_stats_*` | cAdvisor; https + SA bearer |
| metrics-server (EKS add-on) | — (API only) | `kubectl top` | resource API for HPA-prereq; NOT a Prometheus source |

## Pipeline self-metrics (scraped DIRECTLY by Prometheus, Alloy-independent)

`up{job="prometheus|alloy|loki|alertmanager|grafana"}`,
`prometheus_remote_storage_*`, `prometheus_rule_*`, Alloy/Loki/AM internals.
If Alloy dies, `up{job="alloy"}==0` still fires — the pipeline watches itself.

## Recording rules (30s)

`api:http_request_rate5m`, `api:http_error_ratio{5m,30m,1h,6h}`
(zero-safe via `clamp_min`), `api:http_latency_p95_5m`. Dashboards and SLO
burn alerts query recordings, never raw rates twice.

## Logs (stdout → Alloy → Loki; labels: cluster/namespace/pod/container ONLY)

Backend (winston JSON, production): `timestamp, level, service
("chess-backend"), environment, message, requestId?, traceparent?, error?,
method?, path?, + route meta`. Morgan access lines are plain text (combined
+ `req_id=`), URL-scrubbed. Frontend nginx: default combined (stdout) +
error log (stderr); probe locations have `access_log off` (no kubelet spam).
Migration: run.js stdout (batch logs, retained 7d like everything).

Redaction (before serialization, never after): keys matching
password/secret/token/cookie/auth/jwt/session/api-key/credential/email →
`[REDACTED]`; `postgres://…` URLs → scheme + `[REDACTED]`; `AKIA…` →
`[REDACTED_AWS_KEY]`; JWT shapes → `[REDACTED_JWT]`; morgan URLs: sensitive
query keys + JWT path segments scrubbed. NEVER logged: passwords, cookies,
JWTs, auth headers, DB/AWS credentials, secrets, bodies with user data, PII.

Label budget: ≤15 label names/series (Loki-enforced). User/game/request IDs
live in log BODIES (free) — never in labels or metric names.

## CloudWatch (authoritative, not duplicated)

EKS control-plane/audit (`/aws/eks/...` log group, 30d), RDS (`AWS/RDS`
metrics + Performance Insights + postgres log export), ALB (`AWS/ApplicationELB`
+ target health), CloudTrail, VPC flow logs (rejected-traffic signal).
Prometheus queries app-side PROXIES (pool waiters, 5xx) and runbooks name the
CloudWatch metric to correlate — no exporter duplicates AWS-native signals.
