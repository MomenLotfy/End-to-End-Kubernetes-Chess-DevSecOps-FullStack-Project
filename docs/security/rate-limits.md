# HTTP rate limits — inventory & trust chain (Wave 7 Phase 5)

Single documented source for every HTTP throttle in the platform. The app
table below is CHECKER-BOUND to `Chess-Backend/src/services/rateLimit.js`
(Wave 7 checker §12 reconstructs each row from the service specs — change
both or the gate fails). All 7 app limits are preserved verbatim from the
pre-Phase-5 wiring; Phase 5 changed only the STORE (process-local →
shared Redis) and the client-IP attribution it depends on.

## 1. App limiters (express-rate-limit, fixed window, draft-7 headers)

| limiter | route | window | limit | 429 body |
|---|---|---|---|---|
| `global` | `/api` | 900000 ms (15 min) | 100 | `Too many requests` |
| `login` | `/api/auth/login` | 60000 ms (1 min) | 5 | `Too many authentication attempts` |
| `register` | `/api/auth/register` | 900000 ms (15 min) | 5 | `Too many registration attempts` |
| `resend-verification` | `/api/auth/resend-verification` | 900000 ms (15 min) | 3 | `Too many email requests` |
| `forgot-password` | `/api/auth/forgot-password` | 900000 ms (15 min) | 3 | `Too many email requests` |
| `reset-password` | `/api/auth/reset-password` | 900000 ms (15 min) | 5 | `Too many reset attempts` |
| `refresh` | `/api/auth/refresh` | 60000 ms (1 min) | 30 | `Too many refresh attempts` |

- **Identity:** every limiter keys by client IP (`req.ip` via the §3 trust
  chain). There are no user-id keys: the six route limiters guard
  pre-authentication endpoints (no identity exists yet), and the global
  limiter covers authenticated traffic by IP as well (simpler, and strict
  per-account budgets would need a second keying design — explicitly not
  built; see threat W7-T52).
- **429 contract:** status 429, JSON `{ error: <body> }`, draft-7 headers
  (`RateLimit: limit=N, remaining=0, reset=S`, `RateLimit-Policy`,
  `Retry-After`). Failed attempts (401/400) COUNT
  (`skipSuccessfulRequests: false` — brute force must burn budget).
- **Store:** redis mode = one `RedisStore` per limiter over the shared
  Phase 3 `store` client; keys `ratelimit:{limiter}:{ip}`, fixed window,
  TTL = windowMs set atomically with the first increment (Lua). Local
  mode = process-local `MemoryStore` (dev/test only, explicit startup
  selection — never a runtime fallback).
- **Redis down:** FAIL OPEN + LOUD — the request is served uncounted,
  `rate_limit_degraded_total{limiter}` increments per failed command, a
  structured warn is logged, and `ChessRateLimitDegraded` pages (see
  `docs/runbooks/rate-limit-degraded.md`). Chosen over fail-closed because
  a cache outage must not become a self-inflicted total outage; the
  accepted cost is a brute-force window (threat W7-T45).

## 2. Edge limiter (nginx, independent of Redis)

- `limit_req_zone $binary_remote_addr zone=api_per_ip:10m rate=20r/s`,
  applied as `limit_req zone=api_per_ip burst=40 nodelay` on `/api/` —
  identical in compose (`Chess-Frontend/nginx.conf`) and EKS (Helm
  overlay). Rejects excess with **503** (nginx `limit_req` default,
  deliberately unchanged: edge floods still page via `ChessHigh5xxRate`,
  which is desirable — a blocked flood is worth seeing).
- The edge limiter needs no Redis and is unaffected by app-limiter
  degradation: volumetric caps hold while semantic budgets are open.
- Zones are per-nginx-worker (per-pod): the effective edge cap scales with
  frontend replicas. Pre-existing property, unchanged by this phase.

## 3. Trust chain (how `req.ip` becomes the true client)

```
compose: client ──► nginx:8080/8443 ──► backend:5000        (1 hop: trust=1)
EKS:     client ──► ALB ──► nginx:8080 ──► backend:5000      (2 hops, collapsed to 1)
```

- The ALB (pinned `append` mode, no client-port suffix — see the Ingress
  `load-balancer-attributes` annotation) appends the client IP to
  `X-Forwarded-For`. Any client-supplied prefix is attacker-controlled and
  sits LEFT of the appended address.
- nginx `real_ip` (`set_real_ip_from` = the VPC CIDR already documented
  as the ALB source, `real_ip_recursive on`) strips trusted hops
  right-to-left and sets `$remote_addr` to the first untrusted address =
  the true client for all external traffic. This simultaneously fixes the
  edge `limit_req` key AND the XFF the backend reads.
- The backend keeps `TRUST_PROXY_HOPS=1` (validated integer 0–9, FATAL on
  garbage, Helm-pinned): post-rewrite it again sees exactly one trusted
  hop (nginx). `req.ip` = true client; spoofed prefixes are never read.
- Residual: traffic ORIGINATING inside the VPC (compromised pod, debug
  container) can pick its attributed address, because in-VPC sources are
  in the trusted set. Accepted: such a position is already inside the
  trust boundary (threat W7-T47). Direct external access to nginx/backend
  is impossible (ClusterIP-only Services).

## 4. What this phase deliberately did NOT build

- No per-user/per-account budgets (W7-T52 accepts IP-keying, incl. NAT).
- No Socket.io event throttling — the HTTP limiter does not see socket
  events at all (gate G5 stays open with a bounded Phase 7 follow-up).
- No edge-status change (503 stays), no new limiters, no removed
  limiters, no limit/window/message changes (“preserve unless a
  documented security reason” — none was found).
