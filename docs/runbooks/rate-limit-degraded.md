# Runbook: rate limiting degraded (ChessRateLimitDegraded)

## 1. Symptoms

- Alert `ChessRateLimitDegraded` (warning): `sum(increase(rate_limit_degraded_total[10m])) > 10` for 5m.
- Loki shows `Rate limiting degraded: failing open (request allowed, not counted)` with `{limiter, reason}` fields.
- Users report NOTHING (by design — see impact).

**Severity & user impact:** users are unaffected — failed limiter Redis
commands fail OPEN, so requests are served normally, just not counted
against their rate-limit bucket. Security is weakened while firing: the
semantic app limits (5 logins/min, 3 email sends/15min, …) do NOT apply,
so auth endpoints are temporarily brute-forceable. Treat the window as
hostile and run the §3 abuse check afterwards.

**Mitigating control (still active):** the nginx edge limiter
(`limit_req`, 20 r/s per client IP) does NOT use Redis and keeps
enforcing volumetric caps during the outage. Floods are still capped;
only the fine-grained per-endpoint budgets are open. (Edge zones are
per-nginx-pod, as before — effective cap scales with frontend replicas.)

**Traffic behavior while fail-open is active:**

- Every request is served; limiter headers are absent on degraded
  responses (no count exists to report) — clients already tolerate
  missing RateLimit headers (nothing keys on them).
- Added latency: the FIRST degraded request per limiter pays up to ~1s
  (EVALSHA timeout + one script-reload retry, 500ms each); subsequent
  degraded requests fail open instantly until Redis recovers.
- Degraded requests are NEVER counted retroactively: after recovery,
  buckets resume from their pre-outage Redis values (no stale local
  counters exist to merge — there is no local limiter state in redis
  mode). Recovery is automatic — no restart or ArgoCD sync required.
- nginx edge 503s (`limit_req` rejecting floods) are INDEPENDENT of this
  alert and still page via `ChessHigh5xxRate` — during an attack
  overlapping an outage you may see both; they are different layers
  (edge capped, app open). Do not "fix" the outage by tightening nginx.

## 2. First checks (60 seconds)

1. **Scope by limiter:** which `limiter` labels are incrementing — all 7
   (Redis-wide outage) or a subset (unlikely; would indicate key/command
   specific faults, e.g. a Valkey ACL or OOM on one pattern)?
2. **Redis or app?** `redis_connected{client="store"} == 1`?
   - 0 / missing → Redis-side (ElastiCache event, failover, SG change,
     ESO credential rotation). The backend is behaving correctly.
   - 1 but degrading anyway → half-open socket / slow commands (`reason`
     will be `redis_command_failed`, and `redis_command_duration_seconds`
     shows the latency). Suspect network path or Valkey saturation.
3. **Reason split** (`redis_not_ready` vs `redis_command_failed`) in Loki —
   tells you whether the client was down or commands failed mid-flight.

## 3. Prometheus/Grafana queries

```promql
sum by (limiter) (increase(rate_limit_degraded_total[10m]))   # scope per limiter
sum(increase(rate_limit_degraded_total[10m]))                  # alert value
redis_connected{client="store"}                               # 1 = client believes it is up
histogram_quantile(0.99, sum by (le) (rate(redis_command_duration_seconds_bucket{client="store"}[5m])))  # store latency
sum(rate(http_requests_total{status_class="4xx"}[5m]))        # 429s should DROP toward 0 while open
sum(rate(http_requests_total{route="/api/auth/login"}[5m]))   # auth volume during the window (abuse check)
```

Low-traffic caveat: the alert is traffic-triggered — with < ~1 rpm an
outage may take longer than 10m to cross the threshold, or never fire at
zero traffic. `redis_connected{client="store"} == 0` is the traffic-
independent signal; check it whenever ElastiCache maintenance is scheduled.

Post-incident abuse check: login 401 volume during the window
(`route="/api/auth/login"`, `status_class="4xx"` stays, but 429s vanish —
sustained high 401s with zero 429s = someone worked the open window).

## 4. kubectl commands

```bash
kubectl -n chess-staging get pods -l app.kubernetes.io/name=backend
kubectl -n chess-staging logs deploy/chess-backend --tail=200 | grep -i "degraded\|redis"
kubectl -n chess-staging get externalsecret chess-redis -o yaml | grep -A3 Ready  # credential sync state
kubectl -n chess-staging get events --sort-by=.lastTimestamp | tail -20
```

ElastiCache (CLI; staging cache — never production credentials in chat):

```bash
aws elasticache describe-events --source-type cache-cluster --max-records 20
aws elasticache describe-serverless-caches --query '*[].{Name:FullName,Status:Status}'
```

## 5. Logs to inspect (Loki)

- `{namespace="chess-staging",container="backend"} | json | msg=~"Rate limiting degraded.*"`
  fields: `limiter` (which budget), `reason` (`redis_not_ready` = client
  down/reconnecting, instant fail-open; `redis_command_failed` = sent
  command failed/timed-out, ≤ ~1s added latency on the first degraded
  request per limiter, instant after).
- Companion Redis signals: `redis_client_errors_total`, `redis_reconnects_total`,
  backend `error` level (connect TIMEOUTs/retries from the Phase 3 client).

## 6. Likely causes

1. ElastiCache/Valkey maintenance, failover, or node replacement (check AWS
   events + `redis_reconnects_total` spike).
2. Security-group / subnet / NACL change breaking pod → Valkey (TLS 6379).
3. ESO credential rotation desync (ExternalSecret not Ready; auth errors in
   backend logs, `redis_client_errors_total{client="store"}` climbing).
4. Valkey saturation (CPU/engine): commands time out while the client stays
   `ready` — `reason=redis_command_failed`, p99 store latency high.
5. App-side: store client exhausted by a connection leak (no evidence to
   date; `redis_connected` flapping across restarts would suggest it).

## 7. Safe remediation

- **Do NOT restart the backend to "fix" limiting** — restarts change nothing
  (no local state to clear) and drop Socket.io connections. Fix Redis; the
  limiter self-heals on the next request.
- ElastiCache event: wait for AWS failover/maintenance to complete; watch
  `redis_connected{client="store"}` return to 1, then confirm
  `rate(rate_limit_degraded_total[5m])` returns to 0.
- Network/credential cause: fix forward in git (Terraform SG / ESO
  SecretStore), let the pipeline sync; ESO re-syncs ≤5m.
- Saturation: check Valkey CPU/connections in CloudWatch; staging has no
  autoscaling — escalate if sustained (capacity decision, not an app bug).
- After recovery: run the §3 abuse check; if the open window was worked,
  rotate nothing (no credentials are involved) but note it in the incident.

## 8. Rollback/escalation

- There is nothing to roll back in the app (fail-open is the designed
  behavior, not a bad release). If degradation persists >30m with Redis
  reporting healthy, escalate to platform (possible CNI/DNS incident):
  capture `redis_connected`, store p99, backend logs, and events first.
- If you suspect the open window was exploited at scale (credential-stuffing
  success, not just attempts), escalate per the security incident process
  and preserve Loki/auth logs before retention drops them.

## 9. Data/security cautions

- Never paste Secret contents into chat/tickets; describe by key name only.
- The degraded log/metric carry ONLY `{limiter, reason}` — no IPs, keys, or
  commands (verified by unit tests with adversarial error text). If you ever
  see an IP in a degraded log line, that is itself a bug — file it.
- Verify identity attribution after ANY nginx/ingress change: with
  `real_ip` misconfigured, limits silently key by ALB-node IP (see
  docs/security/rate-limits.md §3 "Trust chain"). Spot-check
  `$remote_addr` in frontend access logs against a known client IP.
