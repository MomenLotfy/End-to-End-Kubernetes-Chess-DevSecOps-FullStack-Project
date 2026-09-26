# Wave 7 baseline — scale-out gate (staging)

Living document: each Wave 7 phase appends its section. Phases 1–6 are
COMPLETE below (S3 avatars, Redis infra, Redis app integration, DB-truth
room cache, shared rate limiting, graceful shutdown). Threats live in
`wave7-threat-matrix.md` (W7-T1..T68; G1 closed, G2–G5 open).

## Phase 1 — S3 avatar storage (COMPLETE)

- Store: `Chess-Backend/src/services/avatarStore.js` (`local` default | `s3`;
  invalid mode fails fast). Public URL shape unchanged (`/uploads/avatars/…`).
- Bucket (TF `modules/s3avatars`): private, BPA all-true, BucketOwnerEnforced,
  SSE-S3, DenyNonTLS, versioning Disabled (justified: immutable uuid names),
  MPU-abort lifecycle, `force_destroy=false`.
- Access: backend IRSA role, `s3:Get/Put/DeleteObject` on `avatars/*` only
  (no List, no `*`); pod holds no AWS credentials.
- Reads in s3 mode miss → legacy local file ONLY when
  `AVATAR_S3_LEGACY_FALLBACK=true`, every hit counted
  (`s3_legacy_fallback_reads_total`) — loud, never silent.
- Deletes best-effort + orphan metric; backfill is copy-only; rollback flips
  the flag to `local` (S3-only avatars 404 — documented, accepted window).
- Tests: `tests/avatarStore.unit.test.js` (13: traversal, key safety, failure
  modes, fallback counting, no silent local write).

## Phase 2 — Redis infrastructure (COMPLETE)

### Topology (chosen + why)

**ElastiCache Serverless, engine Valkey 8** (`terraform/modules/elasticache`).
Why serverless: zero node sizing for kilobytes of ephemeral coordination,
VPC-only endpoint, mandatory TLS, usage-capped spend. Why Valkey over Redis
OSS: the serverless storage floor is 100 MB (~$6/mo) vs 1 GB (~$91/mo)
— the workload is ephemeral counters/fan-out/votes, so the Redis floor
would be 15x overpayment for idle capacity. Client compatibility (ioredis,
socket.io adapter) is identical for the commands Wave 7 uses. NOT in-cluster
Redis (no stateful snowflake, no persistence story to get wrong).

Resources: serverless cache + dedicated SG (+1 ingress rule) + Valkey user
+ user group + 48-char random AUTH → dedicated SM secret (`chess/<env>/redis`).

### Security

- Placement: private data-tier subnets (same as RDS); no public IP can exist.
- SG: tcp/6379 from the EKS cluster SG ONLY (RDS-precedent pattern); exactly
  one rule; no `0.0.0.0/0`, no `cidr_blocks` (static-checked).
- AUTH: `chess-app` user, ACL `on ~* allchannels +@all -@dangerous`, password
  in SM only; ESO `chess-redis` delivers {username,password} to the backend
  namespace; ESO IRSA Resource = 4 exact secret ARNs.
- RBAC: no Role grants secret reads; `chess-redis` refs confined to the
  backend Deployment (Phase 3+; checker bans migration/frontend/config refs).
- NetworkPolicy: NO change (documented RDS-precedent decision — enforcement
  is the AWS SG; a backend egress policy would force broad 443 holes with no
  signal). Ingress deny-by-default kept; no 6379 ingress exists.
- Nothing consumes Redis yet: no ioredis/adapter deps, no client code — G1
  (failure-mode definitions) is the Phase 3–5 exit gate.

### Observability (CloudWatch authoritative for the managed cache)

Wave 6 Prometheus stays authoritative for K8s/app. No Redis exporter (no
demonstrated need). Serverless cache health is read from CloudWatch
`AWS/ElastiCache` (USER-SIDE `list-metrics` confirms the exact set):

| Signal | CloudWatch metric | Later use |
|---|---|---|
| Compute | `ElastiCacheProcessingUnits` | throttle/cost watch |
| Storage | `BytesUsedForCache` | leak/growth watch |
| Connections | `CurrConnections` (+`NewConnections`) | pool-sizing proof |
| Latency | `SuccessfulReadRequestLatency` / `…Write…` | SLO-adjacent |
| Efficiency | `CacheHitRate` | (rate-limit reads are hits by design) |
| Pressure | `Evictions`, `ThrottledRequests` | all Wave 7 keys carry TTLs; throttles page the runbook |

### Cost (staging, us-east-1 list, 2026)

| Item | Math | ≈ $/mo |
|---|---|---|
| Storage floor (100 MB Valkey) | 0.1 GB × $0.084 × 730h | $6.13 |
| ECPUs (staging: tens of RPS) | ≈ thousands/hr → ≈ $0.01–0.10 | ≈ $0.10 |
| Snapshots (1-day, KBs) | ≈ $0.085/GiB-mo on ~0 | ≈ $0.00 |
| **Typical total** | | **≈ $6–7** |
| Worst case (caps hit: 1 GB + 5000 ECPU/s) | $61.32 + $30.22 | ≈ $92 ceiling |

Production sizing (ceilings, snapshot policy, CMK) is re-decided with
observed traffic in Wave 8 — no prod apply in Wave 7 (prod root stays
DO NOT APPLY; modules mirrored as planned values; `roles = {}`).

### USER-SIDE REQUIRED (Phase 2 — exact commands)

```bash
# 0. prerequisites: AWS creds with the deployer role, Terraform >= 1.11
cd terraform/environments/staging
cp backend.staging.hcl.example backend.local.hcl   # fill bucket/key/region (gitignored)

# 1. init + plan (STAGING ONLY — never -target prod, never apply prod)
terraform init -backend-config=backend.local.hcl
terraform plan -out=tfplan-staging
# EXPECT: +aws_elasticache_serverless_cache (valkey 8), +SG+rule 6379,
# +user+group, +random_password, +SM secret/version; ESO role +1 ARN; outputs.

# 2. apply staging only
terraform apply tfplan-staging

# 3. verify endpoint (TLS-only, private)
terraform output -raw redis_endpoint_address
aws elasticache describe-serverless-caches \
  --serverless-cache-name chess-staging-redis \
  --query 'ServerlessCaches[0].{Status:Status,Engine:Engine,Version:FullEngineVersion,Endpoint:Endpoint}'

# 4. verify TLS + AUTH WITHOUT printing the password (password never echoes)
ENDPOINT=$(terraform output -raw redis_endpoint_address)
SECRET_ARN=$(terraform output -raw redis_user_secret_arn)
export VALKEYCLI_AUTH="$(
  aws secretsmanager get-secret-value --secret-id "$SECRET_ARN" \
    --query SecretString --output text | python3 -c 'import json,sys; print(json.load(sys.stdin)["password"])'
)"
kubectl run -i --rm valkey-check --restart=Never --image=valkey/valkey:8 -- \
  valkey-cli -h "$ENDPOINT" -p 6379 --tls --user chess-app -a "$VALKEYCLI_AUTH" PING
# EXPECT: PONG (then unset VALKEYCLI_AUTH)
# negative: wrong password must return WRONGPASS; plain (non-TLS) must fail.
unset VALKEYCLI_AUTH

# 5. verify SG reachability boundary (6379 from EKS cluster SG ONLY)
aws ec2 describe-security-groups --filters Name=group-name,Values=chess-staging-redis \
  --query 'SecurityGroups[0].IpPermissions'
# EXPECT: exactly one rule, tcp 6379, UserIdGroupPairs only (no IpRanges).

# 6. verify ESO sync (presence of keys, not values)
kubectl get externalsecret chess-redis -n chess-staging
kubectl get secret chess-redis -n chess-staging -o yaml | grep -E '^  (username|password):'
# EXPECT: ExternalSecret Ready=True; both keys present.

# 7. verify NetworkPolicy posture unchanged
kubectl get networkpolicy -n chess-staging
# EXPECT: default-deny-ingress + allow-frontend-ingress + allow-backend-ingress; NO egress policy.

# 8. verify no public exposure
aws elasticache describe-serverless-caches --serverless-cache-name chess-staging-redis \
  --query 'ServerlessCaches[0].SecurityGroupIds'
# EXPECT: the chess-staging-redis SG from step 5 (VPC-only; serverless has no public endpoint concept).
```

### Risks (Phase 2 residual)

- TF/AWS schema drift (serverless args) can only fail at USER-SIDE plan —
  mitigated by provider-5.x schema research + CI `terraform validate`.
- SM secret name reuse after destroy is blocked 30 days (recovery window) —
  accepted (prevents credential strand); documented for operators.
- Major engine upgrade replaces the cache — safe (ephemeral) + documented.
- G1 open: failure modes undefined until consumers land (Phases 3–5 gate).

## Phase boundary proof (Phase 2 exit)

- backend `package.json`: no `ioredis`, no `@socket.io/redis-adapter` (checker).
- backend src: `redis` appears ONLY in the log-redaction regex (checker).
- `replicas: 1` still pinned; `Recreate` still set; no HPA kind (checker).
- `chess-redis` referenced by NO workload yet (checker).
- Production: modules planned-only, `roles = {}`, DO NOT APPLY intact.
- PostgreSQL remains the ONLY authoritative store (nothing else holds state).

## Phase 3 — Redis application integration (COMPLETE)

Local default is UNCHANGED (socketAdapter=local; compose/dev run zero Redis).
Redis mode activates only when GitOps sets `backend.socketAdapter=redis` +
`redis.host` (Terraform `redis_endpoint_address`); render FAILS otherwise.

### What landed

- Socket.IO Redis adapter (official `@socket.io/redis-adapter` 8.3.0):
  cross-replica EVENT/ROOM fan-out ONLY. `activeRooms` stays a documented
  per-replica cache; PostgreSQL stays authoritative; row locks unchanged.
- 3 dedicated ioredis 6.0.0 clients: adapter-pub, adapter-sub (via
  library `duplicate()`, identical TLS+AUTH), app command client `store`.
- TLS/AUTH: TLS default-true with verification intact; AUTH mandatory;
  plaintext forbidden in production; any misconfig is a startup FATAL
  (crash, never silent-local/plaintext downgrade).
- Lifecycle: startup connect+ping gate (Redis-down = CrashLoop, i.e. LOUD);
  readiness requires store-ready; shutdown quits then force-disconnects
  (bounded, never throws, order asserted by tests).
- Rematch votes: `rematch:{gameId}` Redis SET, integer-validated ids, 1h TTL
  refreshed per vote, quorum 2 distinct userIds, idempotent re-votes.
  Redis-down = `RematchUnavailable` (controlled client error + metric + log);
  departure cleanup best-effort with TTL backstop. NO silent local fallback.
- Metrics (5 new series, fixed-enum labels, cataloged): client errors,
  connected gauge, reconnects, command latency (8 commands + OTHER), rematch
  errors by operation. No alerts (nothing actionable yet — Wave 6 invariant).
- Tests: 28 deterministic unit tests (no live Redis); full backend suite
  70/70. Wave 7 static checker extended to a blocking §10.

### What deliberately did NOT change

- `replicas: 1`, `Recreate`, no HPA/PDB change, no RollingUpdate.
- No shared rate limiting (`rate-limit-redis` absent by checker).
- Socket transports unchanged (polling still on — Phase 4 scope).
- No board state, sessions, or room hydration in Redis (still PostgreSQL).
- No `chess-redis` refs outside the backend Deployment (checker).

### USER-SIDE REQUIRED (Phase 3 — exact commands)

```
# 0. prerequisites: Phase 2 USER-SIDE complete (ESO chess-redis Ready=True),
#    Phase 3 image deployed, staging kubeconfig, ArgoCD access.
# 1. render guard NEGATIVE (no cluster needed): redis mode without host fails
helm template chess deploy/helm/chess --set backend.socketAdapter=redis
# EXPECT: error "backend.socketAdapter=redis requires redis.host (...)"
# 2. render guard POSITIVE: check the exact env the pod will receive
helm template chess deploy/helm/chess -f deploy/helm/chess/values-staging.yaml \
  --set backend.socketAdapter=redis --set redis.host=REDACTED-ENDPOINT \
  --show-only templates/configmap-backend.yaml | grep -E "SOCKET_ADAPTER|REDIS_"
# EXPECT: SOCKET_ADAPTER: "redis", REDIS_PORT: "6379", REDIS_TLS: "true",
# host = endpoint; NO password anywhere in rendered output.
# 3. flip staging to redis mode in the GITOPS repo (not this repo):
#    backend.socketAdapter=redis + redis.host=<TF redis_endpoint_address>;
#    ArgoCD syncs; watch the rollout:
kubectl -n chess-staging rollout status deploy/chess-backend --timeout=180s
kubectl -n chess-staging logs deploy/chess-backend --tail=30 | grep -i redis
# EXPECT: "redis mode=redis host=... tls=true"; CrashLoop instead = Redis
# unreachable (fail LOUD, fix endpoint/SG/AUTH, do NOT flip back silently).
# 4. readiness + metrics prove the store client
kubectl -n chess-staging exec deploy/chess-backend -- wget -qO- http://127.0.0.1:5000/readiness
# EXPECT: {"status":"ready"} (503 while Redis unreachable = correct)
kubectl -n chess-staging exec deploy/chess-backend -- wget -qO- -T 5 \
  http://127.0.0.1:5000/metrics | grep -E "^redis_connected|^rematch_redis_errors_total"
# EXPECT: redis_connected{client="store"} 1 (and the other two clients 1)
# 5. rematch E2E (two browsers, one finished game, both accept rematch)
# EXPECT: exactly one new game starts; with Redis stopped instead:
# "Rematch temporarily unavailable" + rematch_redis_errors_total{add} +1,
# and NO second game created (fail closed, verified in staging by killing
# the Serverless endpoint access via SG rule suspension — restore after).
# 6. shutdown order (delete pod, watch logs)
# EXPECT: "shutdown: closing redis/socket/pool" then exit 0 within grace.
```

### Risks (Phase 3 residual)

- Staging runs socketAdapter=local until the GitOps flip — redis mode is
  unit-tested + USER-SIDE-verified, NOT soak-tested; first flip is watched.
- Redis-down = pod CrashLoop by design (fail LOUD): correct, but staging
  ElastiCache maintenance pages as backend-down until Phase 7+ retries
  backoff strategy is revisited (W7-T30).
- Cross-replica rematch resolution still needs Phase 4 (presence gate is
  exact at 1 replica; multi-replica behavior UNDEFINED until then — G4).
- G1 PARTIALLY closed: adapter + votes fail-closed and tested; the shared
  rate limiter (later phase) still owes its Redis-down contract.

## Phase boundary proof (Phase 3 exit)

- `ioredis 6.0.0` + `@socket.io/redis-adapter 8.3.0` pinned exact; no
  `rate-limit-redis` (checker §8).
- Redis confined to 7 sanctioned src files (checker §8); no identity labels
  in Redis metrics; 5 new series in the telemetry catalog (checker §10).
- `replicas: 1`, `Recreate`, no HPA, no RollingUpdate (checker §8).
- `chess-redis` consumed ONLY by the backend Deployment (checker §5).
- Transports, rate limits, sessions, board state: untouched (diff-reviewed).
- Production: still planned-only, `roles = {}`, DO NOT APPLY intact.

## Phase 4 — DB-truth room cache (COMPLETE)

`activeRooms` is now a DISPOSABLE cache: any replica materializes any room
from PostgreSQL on demand. Entries are never synchronized — they converge
by rebuilding from the same truth. Row locks remain the write arbiter.

### What landed

- `Game.findRoomSnapshot(roomId)`: ONE query (game row + ordered moves,
  multiplayer only, NO status filter — callers decide acceptance).
- Shared `buildRoomFromSnapshot` for boot/hydrate/refresh (corrupt FEN →
  log + abandon + null, the old boot behavior, now everywhere).
- `getRoom` (hydrate on miss, in-flight dedup so concurrent misses share
  ONE object — never forked operation chains) — used by JOIN ONLY.
- `getCachedRoom` for move/resign/game_over/rematch/leave: those paths
  require a LOCAL socket attachment, which exists only on cached rooms —
  so a miss is authoritative with NO DB read (stray calls can't linger).
- `refreshRoomFromDb` before every mutation decision: rebuilds game fields
  from truth, reattaches local sockets BY USERID (rematch swaps colors),
  carries the operation chain. Proven-dead entries evicted; DB FAULTS keep
  the entry (retry, not rejoin). Callers MUST use the returned object.
- `presenceByUser` (adapter `fetchSockets`, 3s bound): join's
  bothConnected gate + rematch quorum gate are now CLUSTER-WIDE and
  fail-closed (unknown = absent = wait). No new Redis keys — presence is
  a live adapter query, not stored state.
- Finished games hydrate (in_progress + finished materialize): rematch-
  rejoin works on ANY replica and survives restart (uniformity, not an
  accident). Joining an ended game replays `game_ended` (result/winner
  from DB, `eloChange: null`, `replayed: true`) — zero client change
  (the ended screen already guards null ELO).
- Fixed latent crash: fresh non-completing joins crashed on
  `reconnecting.color` (undefined) — the joiner's own seat is used now.
- Disconnect re-looks-up the LIVE entry (refresh may have replaced the
  object mid-flight); leave evicts finished+empty; rejected joins evict
  socketless entries (no probe lingering — checker-pinned).
- Transports: websocket ONLY, server + frontend pinned (see decision).
- Metrics: `room_hydrations_total{created,refreshed,not_found,invalid,
  error}`, `presence_checks_total{ok,failed}` — fixed enums, cataloged.
  No alerts (failures correlate with redis/db signals already present).
- Tests: 20 deterministic hydration tests (cold join, poison-heal,
  loser-adopts-winner, ended-replay, divergence-resolve, presence-wait,
  dead-adapter loud-block, polling-400, websocket-e2e). Backend 92/92,
  frontend 16/16. Wave 7 checker extended to blocking §11.

### Decision: websocket-only, ALB stickiness REJECTED (supersedes §1.2 item 2)

Gate §1.2 prescribed "sticky sessions AND adapter" assuming POLLING is
retained: Engine.IO transport state is per-process and the Redis adapter
does not sync it, so polling + N replicas REQUIRES affinity. Phase 4
removes the need instead of feeding it: one long-lived websocket per
client means the ALB routes the HTTP upgrade ONCE and never sees the
client again — no stickiness knob, no AWSALB-cookie interplay with
`SameSite=Strict` auth cookies, no pinned-to-draining-pod edge during
rollouts, no polling overhead. ALB + frontend nginx already speak
`Upgrade` (config-verified, zero infra change); the frontend already
tried websocket first, now pinned. Tradeoff accepted: clients behind
websocket-blocking middleboxes cannot play (loud connect failure, not
silent breakage); rollback = revert one line per side. Recorded in
ADR-003 (amendment) + threat matrix (W7-T40/T41); the checker BANS
`stickiness` annotations so the knob can't creep back "to be safe".

### What deliberately did NOT change

- `replicas: 1`, `Recreate`, no HPA/PDB, no RollingUpdate.
- No shared rate limiting (`rate-limit-redis` absent — Phase 5).
- No drain redesign (Phase 6); boot `rebuildActiveRooms` kept as warm-up
  (finished games now lazy-load instead of boot-loading — strictly less).
- Socket-event rate limiting: STILL NONE (pre-existing; W7-T37/G5).
- claimBlack/join race: unchanged code (DB-atomic; re-verified, not new).

### USER-SIDE REQUIRED (Phase 4 — exact commands)

Multi-replica behavior is LOGIC-proven + unit-tested here; LIVE 2-replica
proof stays Phase 7's staging gate (replicas are still 1 — no temporary
scale-ups; the gate means the gate). Phase 4 USER-SIDE = 1-replica
regression proving no behavior broke:

```
# 0. prerequisites: Phase 3 USER-SIDE complete, Phase 4 image in staging.
# 1. play a full game (two browsers): create → join → moves → resign.
# EXPECT: identical to Phase 3 (game_start/move_made/game_ended payloads
# unchanged for live games).
# 2. rematch + rejoin-after-finish: after game_ended, close one browser,
#    reopen, rejoin the same room.
# EXPECT: game_ended replay (result/winner shown, no ELO delta) then both
# accept → exactly one new game.
# 3. polling is loudly dead (from any staging shell):
kubectl -n chess-staging exec deploy/chess-backend -- \
  wget -qO- http://127.0.0.1:5000/socket.io/?EIO=4'&'transport=polling; echo "exit=$?"
# EXPECT: HTTP 400 (Transport unknown), immediate — never a hang.
# 4. metrics present (same exec pattern):
kubectl -n chess-staging exec deploy/chess-backend -- wget -qO- \
  http://127.0.0.1:5000/metrics | grep -E "^room_hydrations_total|^presence_checks_total"
# EXPECT: both series present (play step 1 first to generate samples).
# 5. logs show no hydration errors during steps 1-2:
kubectl -n chess-staging logs deploy/chess-backend --tail=200 | grep -iE "hydration|presence" || echo CLEAN
# EXPECT: CLEAN (or only ready/info lines — no failed/error lines).
```

### Risks (Phase 4 residual)

- Live multi-replica proof deferred to Phase 7 BY DESIGN (replicas gate).
- Refresh adds ~1 SELECT per socket mutation (indexed PK/FK, human-scale)
  — negligible at staging load; no N+1 shape (single snapshot query).
- `fetchSockets` per join/rematch-accept = one adapter round-trip (Redis
  in redis mode): human-scale, bounded 3s, fail-closed. Not on the move
  path (turns stay DB-truth, no presence cost per move).
- Socket-event flooding has no throttle (pre-existing, G5): an authed
  client can spam events; each miss costs ≤1 cheap snapshot read (join)
  or zero (other paths). Accepted for staging.
- G1 PARTIALLY closed (unchanged remainder): the shared limiter still
  owes its Redis-down contract (Phase 5).

## Phase boundary proof (Phase 4 exit)

- ONLY join hydrates (`await getRoom` ×1); 5 mutation paths cache-only;
  no raw roomId keys; socketless eviction (checker §11).
- `findRoomSnapshot` shape pinned (no status filter); claimBlack/FOR
  UPDATE untouched (checker §10 re-run green).
- `transports: ["websocket"]` server + frontend + both test suites;
  `"polling"` string absent from both socket configs; NO `stickiness`
  annotations (checker §11 bans).
- 2 new series in code + catalog with fixed enums (checker §11).
- `replicas: 1`, `Recreate`, no HPA, no RollingUpdate (checker §8).
- `rate-limit-redis` absent (checker §8); `chess-redis` backend-only (§5).
- Production: still planned-only, `roles = {}`, DO NOT APPLY intact.

## Phase 5 — shared rate limiting (COMPLETE)

The 7 HTTP limiters are preserved VERBATIM (scopes/windows/limits/bodies/
headers — see `docs/security/rate-limits.md`, checker-bound to code) and
moved from process-local `MemoryStore` to `RedisStore`s over the shared
Phase 3 `store` client. Client-IP attribution — the key the buckets hang
on — is fixed first: the EKS chain keyed BOTH layers by ALB-node IP
(latent shared buckets); nginx `real_ip` + pinned ALB append-mode + a
validated `TRUST_PROXY_HOPS=1` now attribute the true client.

### What landed

- `services/rateLimit.js`: the single limiter spec table (7 scopes) +
  `createRateLimiters({ mode, store })`. Local mode = `MemoryStore`
  (dev/test only, explicit startup selection); redis mode = 7
  `RedisStore`s (`rate-limit-redis@4.3.1`, pinned for ERL 7.5.1) with
  per-limiter prefixes over the EXISTING `store` client — no new
  client/secret/endpoint/DB. `server.js` mounts from the specs (order
  unchanged); `express-rate-limit` no longer imported there.
- Atomic fixed windows: one Lua script per increment (`PTTL<=0` →
  `SET key 1 PX windowMs`, else `INCR`) — concurrent first requests
  can't lose the TTL; keys `ratelimit:{limiter}:{ip}`; `windowMs` ==
  TTL; no sliding extension (`resetExpiryOnChange` banned by checker).
- Fail OPEN + LOUD (the Redis-down contract): store errors pass the
  request through (`passOnStoreError`, redis mode only) while EVERY
  failed command emits `rate_limit_degraded_total{limiter}` (fixed
  7-name enum, cataloged) + a structured warn `{limiter, reason}` with
  fixed reasons. No MemoryStore fallback exists anywhere on the redis
  path — proven by test (same IP 4x past limit still passes) + checker.
- Fast degradation: not-ready client rejects INSTANTLY (no offline-queue
  buildup, no reconnect hammering); ready-but-hanging commands bounded
  by 500ms each (~1s worst case on the first degraded request per
  limiter, instant after). Recovery is automatic — buckets resume from
  pre-outage Redis values; uncounted requests stay uncounted (no local
  counters exist to merge). Constructor script-load rejections are sunk
  (no `unhandledRejection` crash) and self-heal on first use.
- Sanitized error path: the wrapper throws FRESH errors (originals, which
  can embed keys/commands, are dropped) — adversarial-error tests prove
  no IP/command reaches metrics, logs, or bodies.
- Identity chain: nginx `real_ip` (`set_real_ip_from` = the VPC CIDR
  already documented as the ALB source — zero new values, zero CI
  changes — recursive) fixes the edge `limit_req` key AND the XFF the
  backend reads; backend `TRUST_PROXY_HOPS` validated (integer 0–9,
  FATAL) and Helm-pinned `"1"`; ALB `append` mode + disabled
  `xff_client_port` pinned via Ingress annotation. External attribution
  is exact; in-VPC self-attribution is the accepted residual.
- Alert `ChessRateLimitDegraded` (warning, `increase[10m] > 10`, 5m) +
  runbook `rate-limit-degraded.md` (traffic behavior, latency bounds,
  abuse check, edge-503 interplay, low-traffic caveat).
- Tests: 24 deterministic rate-limit tests (all 7 thresholds/bodies/
  headers/keys/TTLs, per-client isolation, fixed-window reset,
  local-vs-redis 429 parity, 2-replica sharing, 50-way concurrent
  first-hits, 6 degradation/recovery proofs, 4 full-stack mount/trust
  tests). Backend 117/117, frontend 16/16. Wave 7 checker §12 (blocking).

### Decision: fail-open + LOUD, and identity-before-sharing (no ADR — rationale)

Two decisions, both with rejected alternatives recorded here:

1. FAIL OPEN (not closed) on Redis faults. A cache outage must not
   become a self-inflicted total outage — fail-closed would reject every
   login/register/refresh AND hand any Valkey disturber a full-DoS
   switch. The cost (a bounded brute-force window) is contained by the
   Redis-independent edge limiter, ≤ ~10m detection, and post-window
   abuse checks (full statement in threat matrix, W7-T45).
2. Fix attribution BEFORE sharing buckets. Migrating ALB-IP-keyed
   limiters to Redis would have built globally-exhaustible buckets
   (one office's traffic 429ing strangers behind the same ALB node).
   The real_ip fix is prerequisite work, not scope creep — and reusing
   the documented `vpcCidr` kept it to zero new values.

### What deliberately did NOT change

- `replicas: 1`, `Recreate`, no HPA/PDB, no RollingUpdate, no drain
  redesign (Phase 6 owns shutdown).
- No hydration/rematch/chess-state changes (`gameSocket.js`, `Game.js`,
  `rematchVotes.js` untouched — verified by diff).
- No new Redis client/secret/endpoint/DB; no Socket.io adapter changes.
- No limit/window/message/header/status changes (preserved verbatim);
  no new or removed limiters; no per-user budgets; no socket-event
  throttling (G5 stays open); edge 503 behavior unchanged.

### USER-SIDE REQUIRED (Phase 5 — exact commands)

Staging proof the shared limiter + trust chain work end to end (replaces
nothing — Phase 4 USER-SIDE stays valid):

```
# 0. prerequisites: Phase 5 image in staging, redis mode (SOCKET_ADAPTER=redis).
# 1. render check (helm; trusted-proxy value flows, zero CI changes needed):
helm template chess-staging deploy/helm/chess -f deploy/helm/chess/values-staging.yaml \
  --set global.registry=000000000000.dkr.ecr.us-east-1.amazonaws.com \
  --set backend.image.digest=sha256:<64hex> --set frontend.image.digest=sha256:<64hex> \
  --set migration.image.digest=sha256:<64hex> --set database.host=chess-staging.invalid \
  --set origins.frontendUrl=https://staging.chess.invalid --set ingress.host=staging.chess.invalid \
  --set ingress.certificateArn=arn:aws:acm:us-east-1:000000000000:certificate/00000000-0000-0000-0000-000000000000 \
  --set networkPolicies.vpcCidr=10.20.0.0/16 \
  --set networkPolicies.nodeCidrs={10.20.48.0/20,10.20.64.0/20} \
  --set eso.rdsMasterSecretArn=arn:aws:secretsmanager:us-east-1:000000000000:secret:rds!db-000000 \
  --set eso.redisSecretArn=arn:aws:secretsmanager:us-east-1:000000000000:secret:chess/staging/redis-000000 \
  --namespace chess-staging | grep -E "set_real_ip_from|real_ip_recursive|TRUST_PROXY_HOPS|xff_header_processing"
# EXPECT: set_real_ip_from 10.20.0.0/16; real_ip_recursive on; TRUST_PROXY_HOPS "1";
# xff_header_processing.mode=append + xff_client_port.enabled=false on the Ingress.
# 2. nginx real_ip module present in the shipped image:
kubectl -n chess-staging exec deploy/chess-frontend -- nginx -V 2>&1 | grep -o http_realip_module
# EXPECT: http_realip_module (absent => pod fails closed at boot on the unknown
# directive — deploy stops loudly, never silently unattributed).
# 3. ALB XFF contract on the provisioned LB (replace with the real LB ARN):
aws elbv2 describe-load-balancer-attributes --load-balancer-arn <alb-arn> \
  --query 'Attributes[?Name==`routing.http.xff_header_processing.mode` || Name==`routing.http.xff_client_port.enabled`]'
# EXPECT: append + false (controller-applied from the Ingress annotation).
# 4. 429 contract for all 7 limiters (7 probes, not 6: global + 6 routes —
#    the two email routes share a shape but are separate buckets, so both are
#    probed). Loop each route to limit+1 from staging (curl), e.g. login x6:
for i in $(seq 1 6); do curl -sk -o /dev/null -w "%{http_code} " -X POST https://staging.chess.invalid/api/auth/login \
  -H 'Content-Type: application/json' -d '{}' -H 'Origin: https://staging.chess.invalid'; done; echo
# EXPECT: 401 401 401 401 401 429 + body {"error":"Too many authentication attempts"}
# + RateLimit/Retry-After headers on the 429. Repeat per docs/security/rate-limits.md
# (register x6, resend x4, forgot x4, reset x6, refresh x31, global: 101 GETs /api/… → 429
# "Too many requests"). Use distinct source IPs per probe (or wait out windows).
# 5. BREAK Redis (staging only): revoke the Valkey ingress rule or rotate the SM
#    password WITHOUT updating ESO, then send login traffic for 2 minutes.
# EXPECT: logins SERVED (401s, no 429s); rate_limit_degraded_total{limiter="login"}
# climbing; Loki "failing open" warns; NO crash, NO 500s from the limiter.
# 6. heal Redis (restore rule/secret, wait ≤5m for ESO re-sync if touched).
# EXPECT: degraded rate returns to 0 with NO restart; next logins counted again
# (6 rapid => 429); buckets resume pre-outage values (no retroactive counting).
# 7. alert timing sense-check: note break time (step 5) vs ChessRateLimitDegraded
#    firing in Alertmanager/Grafana.
# EXPECT: fires within ~15m at any staging traffic ≥ ~1 rpm; low-traffic lag is
# KNOWN (traffic-triggered metric — see runbook §4 caveat), not a failure.
# 8. frontend regression: log in, register a throwaway, play moves, check console.
# EXPECT: identical to Phase 4; zero console errors.
# 9. 429s in metrics (after step 4): /metrics shows http_requests_total{route=…,
#    status_class="4xx"} for the probed patterns with NO raw IPs/paths.
kubectl -n chess-staging exec deploy/chess-backend -- wget -qO- http://127.0.0.1:5000/metrics \
  | grep -E "^http_requests_total.*4xx|rate_limit_degraded_total"
# EXPECT: 4xx series on route PATTERNS only; degraded series present (0 or post-step-5 counts).
# 10. boundary regression (unchanged posture):
kubectl -n chess-staging get deploy chess-backend -o jsonpath='{.spec.replicas}/{.spec.strategy.type}{"\n"}'
kubectl -n chess-staging get hpa,pdb -l app.kubernetes.io/part-of=chess 2>&1 | tail -2
# EXPECT: 1/Recreate; no HPA/PDB. Plus: play a rematch (rematchVotes path) and
# rejoin-after-finish (hydration path) — both behave EXACTLY as Phase 4.
# 11. 429 UX check (no frontend 429 handling exists — document what users see):
# trigger a login 429 (step 4) in a real browser.
# EXPECT (document actual): the form shows the generic error text; no hang, no
# console exception. If the UX is confusing, file (don't fix) — frontend 429
# handling is Wave 8 scope, explicitly not this phase.
```

### Risks (Phase 5 residual)

- Alert is traffic-triggered: < ~1 rpm delays detection (runbook documents
  `redis_connected` as the traffic-independent companion signal).
- First degraded request per limiter pays ≤ ~1s (then instant); recovery
  needs no restart but the ALERT clears on its own 5m+10m cadence.
- In-VPC traffic can self-attribute (accepted; outside the external
  threat model — W7-T47).
- No per-account budgets: NAT collateral + rotation bypass accepted for
  staging (W7-T52); WAF/advanced throttling is Wave 8.
- Socket-event flooding still unthrottled (G5 open, unchanged).
- IPv6 clients: keys carry colons (exact-match only, never globbed —
  safe); `binary_remote_addr` handles both families.
- Valkey key-space under IP-rotation flood: TTL-bounded (≤15min), Serverless
  scales, Phase 2 cost ceilings apply — a cost blip, not an outage (W7-T50).

## Phase boundary proof (Phase 5 exit)

- 7 limiters preserved verbatim: specs == pre-Phase-5 values (tests pin
  all thresholds/bodies; doc rows checker-bound to code — §12).
- ONE Redis client reused (`store`); no new client/secret/endpoint/DB
  (only `rate-limit-redis@4.3.1` added, pinned for ERL 7.5.1).
- `MemoryStore` only in the local branch (`new MemoryStore` ×1, in
  `createRateLimiters` local path; absent from server.js — §12); no
  `resetExpiryOnChange`; no `KEYS`/`SCAN`; error path sanitized (§12).
- Trust chain pinned: `TRUST_PROXY_HOPS: "1"`, real_ip lines +
  `required vpcCidr`, ALB append/no-port annotation (rendered + §12).
- `ChessRateLimitDegraded` + runbook; 1 cataloged series, fixed enum (§12).
- `replicas: 1`, `Recreate`, no HPA/PDB/strategy change (§8 re-run green).
- `gameSocket.js`, `Game.js`, `rematchVotes.js`, avatar/S3 paths: zero
  diff (no hydration/rematch/chess-state change).
- Production: still planned-only, `roles = {}`, DO NOT APPLY intact.

## Phase 6 — bounded graceful shutdown (COMPLETE)

SIGTERM now runs a bounded deterministic drain instead of the old
hang-then-hope sequence (`io.close` into a second HTTP close, unbounded
room/pool waits, no deadline). The pod flips to DRAINING at termination
start (preStop trigger), refuses new work at four gates, finishes what it
holds inside per-phase caps, and exits — 22s application cap inside the
unchanged 30s grace (5 preStop + 22 app + 3 SIGKILL margin).

### What landed

- `services/shutdown.js` (NEW, sole controller): the
  RUNNING→DRAINING→STOPPING→STOPPED machine, one CAS sequence runner
  (SIGTERM/SIGINT/crash converge; duplicates ignored + counted), and the
  phase order settle→HTTP→room→socket→cache→PG. Every phase is clamped
  to the remaining global budget (caps 2+3+6+2+5+3 = 21s + 1s slack);
  per-phase timeout/force is routine (exit 0); only the 22s watchdog, a
  sequence internal error, or a crash exits 1.
- Sole-closer coupling (the Phase 6 load-bearing fix): `io.close()` is
  the ONLY path that closes the attached HTTP server — application code
  never calls the HTTP close (checker bans the literal; a unit test pins
  one call site). Idle keep-alive is destroyed before/during the close
  (unref'd 100ms sweep); stragglers past the 1.5s race are force-
  destroyed once (socket primitive, not a second close), 0.5s settle,
  then the sequence proceeds even if the promise never resolves.
- preStop trigger-then-sleep (the ONLY Helm change): `GET
  /internal/enter-drain` is loopback-only (else 403), idempotent, and
  can ONLY flip DRAINING — it never runs phases. The hook triggers at
  T+0 (readiness 503s immediately) then `sleep 5` for endpoint
  propagation; SIGTERM runs the sequence. `wget` mirrors the proven
  HEALTHCHECK binary; the `;` makes a failed trigger converge safely
  via SIGTERM (logged `prestopSeen=false`). Probes, grace, replicas,
  strategy: byte-identical.
- Room drain without silent drops: new ops while draining reject with
  `ShutdownDrainError{code: SHUTDOWN_DRAINING}` (every traced caller
  already handles rejection; the chain object is untouched so the
  snapshot stays valid). The packet gate is the primary client signal
  (`Server shutting down` error/ack on every packet — chat included);
  the `disconnect` catch ignores the routine rejection (memory-only
  detach; vote cleanup is TTL-backed). Expiry abandons, never cancels:
  chess truth stays transactional in PG (abort rolls back, locks
  release), games recover on next boot.
- Cache/PG close: the existing quit-then-force path now returns an
  explicit `{closedClean}` result (force path warns); `pool.end()` runs
  exactly once behind a module guard, raced against remaining budget.
  Ordering socket→cache→PG keeps the chess-state authority last.
- Telemetry (4 cataloged series, fixed enums only): `shutdown_state`
  (0–3 gauge), `shutdown_rejected_total{http,socket,room}`,
  `shutdown_phase_total{6 phases × completed,timeout,forced}`,
  `shutdown_signals_total{SIGTERM,SIGINT × accepted,ignored}`. Logs:
  DRAINING entry, sequence start, per-phase start/end with durations,
  every force/timeout as warn, duplicate signals, final STOPPED/exit.
  No identities, paths, or secrets in any of it. No new alert: routine
  forces during deploys are expected, not pageable (W7-T68).
- 38 deterministic unit tests (fakes + short budgets + real timers; no
  live Redis/PG/K8s): state machine, endpoint (loopback/non-loopback/
  idempotent/never-executes), gates, guards, room rejection + chain
  preservation + bounded drain, exact phase order, sole-closer + sweep
  + force paths, cache/PG clean/forced/timeout, watchdog arm/clear,
  exit codes, duplicate sequences/signals, and two `createApplication`
  wiring tests. Two pre-existing tests gained one cleanup line each
  (global drain state reset; assertions untouched).
- Checker §13 (blocking, Phases 1–5 untouched): sole `io.close` site,
  no direct HTTP close, no double-close string, state/error/guard
  surface, 22s budget arithmetic, trigger + loopback + metrics
  exclusion, preStop trigger-before-sleep, room-gate needles,
  `{closedClean}`, 4 series in code + catalog, suite registration, and
  the still-shut scale-out gate (replicas 1, Recreate, no HPA/backend
  PDB/RollingUpdate, probes + grace pinned, migration set pinned,
  frontend/nginx/rate-limit boundaries).

### USER-SIDE REQUIRED (Phase 6 — exact commands)

```bash
# 0. prerequisites: Phase 6 image in staging (any SOCKET_ADAPTER mode).
# 1. trigger is loopback-only + immediate (from any staging shell):
kubectl -n chess-staging exec deploy/chess-backend -- \
  wget -qO- http://127.0.0.1:5000/internal/enter-drain; echo "exit=$?"
# EXPECT: {"draining":true,...} — and readiness flips at once:
kubectl -n chess-staging exec deploy/chess-backend -- \
  wget -qO- http://127.0.0.1:5000/readiness; echo "exit=$?"
# EXPECT: not-ready (HTTP 500-class) while /liveness stays 200.
# 2. non-loopback trigger rejected (from the frontend pod — backend-only
# network path, non-loopback source):
kubectl -n chess-staging exec deploy/chess-frontend -- \
  wget -qO- http://chess-backend:5000/internal/enter-drain; echo "exit=$?"
# EXPECT: HTTP 403.
# 3. rolling restart drains inside grace (watch one pod):
kubectl -n chess-staging rollout restart deploy/chess-backend
kubectl -n chess-staging logs -f deploy/chess-backend --tail=40
# EXPECT: "entering DRAINING" -> phase start/finish lines -> "Shutdown
# complete" with exit 0, total well under 30s; no "global deadline" line.
# 4. metrics present after a drain (same exec pattern):
kubectl -n chess-staging exec deploy/chess-backend -- wget -qO- \
  http://127.0.0.1:5000/metrics | grep -E "^shutdown_(state|rejected|phase|signals)"
# EXPECT: state/rejected/phase/signal series (generate drain traffic first).
# 5. chess truth survives a mid-game restart: start a game, move twice,
# restart (step 3), rejoin — EXPECT: position intact (PG authority).
```

### Risks (Phase 6 residual)

- Watchdog-fire outcome is not unit-simulated (every phase is clamped,
  so completion always wins the race in every constructible case; the
  watchdog is a last-resort backstop). Pinned instead: armed with the
  exact cap, cleared on completion, exit-once. A `Shutdown global
  deadline exceeded` line in staging logs means a real wedge — escalate.
- Readiness-probe cadence (10s × 6) cannot drive endpoint removal inside
  30s — BY DESIGN not relied upon (control-plane terminating-pod
  removal + 5s preStop + 2s settle + app gates are the mechanisms).
- Pre-flip straddlers: a `create_room` already inside its DB write when
  DRAINING begins still commits (safe: row persists, next boot
  rebuilds, client rejoins); a straddled `join_room` may report the
  generic `Room is full` instead of `Server shutting down` (safe,
  client retries on the new pod).
- `statement_timeout` (10s) exceeds the 6s room cap: pathological
  queries abandon at 6s and finish or roll back on their own —
  transactional guarantees hold, but staging logs may show a timeout
  warn under a wedged DB (expected, not an incident).
- Socket-event flooding still unthrottled (G5 open, unchanged).

## Phase boundary proof (Phase 6 exit)

- `replicas: 1`, `Recreate`, no HPA, no backend PDB, no RollingUpdate
  (§8 + §13 re-run green); grace still 30s; probes byte-identical.
- Helm diff is the preStop block ONLY (one lifecycle stanza, trigger
  ordered before sleep — §13 asserts the ordering).
- No migration added/changed (file set pinned — §13); no Terraform
  diff; no frontend/nginx diff; no rate-limit/limiter diff; no Redis
  architecture diff (3-client shape re-pinned by §12 re-run).
- Chess semantics untouched: no game/elo/hydration/rematch logic
  change (only the roomTask gate + bounded drain + one disconnect-catch
  predicate + guard wiring); PG still the only game-truth store.
- G1 CLOSED (matrix W7-T56–T68); G4 REMAINS the Phase 7 gate —
  scale-out is not opened.
- Production: still planned-only, `roles = {}`, DO NOT APPLY intact.
