# Wave 7 DevSecOps threat matrix — scale-out gate

Scope: everything Wave 7 adds, phase by phase. Phases 1–6 are built
(S3 avatars, Redis infra, Redis app integration, DB-truth room cache,
shared rate limiting, graceful shutdown); Phases 7–10 extend this matrix
(replicas, PDB, HPA, observability). Wave 6 threats live in
`wave6-threat-matrix.md`.

Likelihood/Impact: L/M/H. Residual: ACCEPT (staging) or MITIGATE (built in).

## Phase 1 — S3 avatar storage (BUILT)

| # | Threat | Attack path | Mitigation (built) | L | I | Residual |
|---|---|---|---|---|---|---|
| W7-T1 | Public avatar bucket | misconfigured policy/ACL exposes user images | BPA all-true + BucketOwnerEnforced + no ACL headers in code + static checks | L | H | ACCEPT |
| W7-T2 | Cleartext S3 traffic | credential/object sniffing off-cluster | bucket DenyNonTLS policy; SDK defaults to TLS; IRSA token never on wire in clear | L | M | ACCEPT |
| W7-T3 | IRSA overprivilege | compromised pod lists/shares/reads other buckets | 3 object actions on `avatars/*` only; no ListBucket, no `*`; TF validation bans `Action:"*"` | L | H | ACCEPT |
| W7-T4 | Static AWS credentials | long-lived keys in env/git/values | no keys anywhere: IRSA web identity; `backendRoleArn` is an ARN, not a secret; secret sweeps in CI | L | H | ACCEPT |
| W7-T5 | Path traversal → arbitrary S3 key | crafted filename escapes `avatars/` | strict `user\d+-uuid.webp` regex at store boundary; key builder throws otherwise; unit-tested | L | H | ACCEPT |
| W7-T6 | Malicious content served as avatar | polyglot/malware upload, content sniffing | sharp re-encode to webp (metadata stripped), fixed `image/webp` Content-Type, `nosniff` via helmet | L | M | ACCEPT |
| W7-T7 | Split-brain local/S3 storage | writes diverge, reads inconsistent | single-write mode (`AVATAR_STORAGE`), no dual-write; legacy reads LOUD-counted; mode invalid → fail fast | L | M | ACCEPT |
| W7-T8 | Orphan S3 objects (cost/privacy) | failed deletes accumulate | best-effort delete + warn + `s3_operations_total{delete,error}`; reconciler runbook (explicit, not blind TTL) | M | L | ACCEPT (staging) |
| W7-T9 | Backfill data loss | migration script deletes/mangles originals | backfill is copy-only (local files untouched until verified); rollback = flip flag to local | L | M | ACCEPT |
| W7-T10 | Rollback 404s for S3-only avatars | revert strands new uploads | documented in runbook; dual-availability only via re-backfill; accepted staging window | M | L | ACCEPT (staging) |

## Phase 2 — Redis infrastructure (BUILT)

| # | Threat | Attack path | Mitigation (built) | L | I | Residual |
|---|---|---|---|---|---|---|
| W7-T11 | Public Redis exposure | internet-reachable cache endpoint | serverless VPC-only endpoint in private data subnets; no public IP exists; static checks | L | H | ACCEPT |
| W7-T12 | 0.0.0.0/0 SG ingress on 6379 | world-readable/writable cache | dedicated SG, ONE rule (6379 from EKS cluster SG); checker bans `0.0.0.0/0` + `cidr_blocks` | L | H | ACCEPT |
| W7-T13 | TLS disabled / cleartext AUTH | credential sniffing on VPC | serverless mandates in-transit encryption (no insecure mode); app dials `rediss://` only (Phase 3+) | L | H | ACCEPT |
| W7-T14 | AUTH credential leakage | password in TF outputs/values/logs/state-visible git | 48-char random → SM only; no password output; ESO delivery; secret sweeps; never printed | L | H | ACCEPT (state holds ciphertext-equivalent by TF design) |
| W7-T15 | Unauthorized pod access to chess-redis | non-backend SA mounts the ESO secret | no Roles grant secret reads; static check confines `chess-redis` refs to backend-only (Phase 3+) | L | M | ACCEPT |
| W7-T16 | Excessive SG access | extra ingress sources added later | checker asserts exactly ONE ingress rule + pinned ports + SG-ref source | L | M | ACCEPT |
| W7-T17 | Redis becomes authoritative state | game truth drifts from PostgreSQL | ARCHITECTURE RULE: ephemeral coordination only (fan-out, counters, votes); no game writes to Redis — enforced by Phase 3–5 review + checker | L | H | ACCEPT (rule + review) |
| W7-T18 | Redis failure → unsafe local fallback | outage silently weakens multi-replica safety | no fallback exists in Phase 2 (nothing consumes Redis); Phases 3–5 MUST define fail-open-loud/closed per consumer — tracked as an open gate below | M | H | OPEN → Phase 3–5 |
| W7-T19 | Resource exhaustion / cost blowout | runaway client burns ECPUs/storage | `cache_usage_limits` (1 GB, 5000 ECPU/s → throttle); staging ceiling ≈ $92/mo; typical ≈ $7/mo | L | M | ACCEPT |
| W7-T20 | Stale snapshot restore | old counters/votes resurrected after incident | retention 1 day crash-convenience only; NO restore runbook (documented: restores would be wrong) | L | M | ACCEPT |
| W7-T21 | Weak AUTH password | brute-forced AUTH | 48-char alphanumeric random (≈285 bits); independent of app secrets | L | M | ACCEPT |
| W7-T22 | Valkey user privilege excess | compromised app user flushes/reconfigures | ACL denies `@dangerous`; single-purpose cache (no other tenant data) | L | M | ACCEPT |
| W7-T23 | ESO over-read | ESO role reaches unrelated secrets | Resource = 4 exact ARNs (no wildcards except AWS-mandated SM suffix `*`) | L | M | ACCEPT |
| W7-T24 | NetworkPolicy weakening for Redis | broad egress rule added "to reach ElastiCache" | NO egress policy added (documented RDS-precedent decision); ingress deny-by-default kept; checker bans 6379 ingress + egress policyTypes | L | M | ACCEPT |

## Phase 3 — Redis application integration (BUILT)

| # | Threat | Attack path | Mitigation (built) | L | I | Residual |
|---|---|---|---|---|---|---|
| W7-T25 | Silent local/plaintext downgrade | misconfig boots an unprotected single-node socket plane | explicit `SOCKET_ADAPTER` mode; bad/missing redis config = startup FATAL; prod plaintext refused; unit-tested fail-closed | L | H | ACCEPT |
| W7-T26 | AUTH/TLS bypass on a split client | sub/store client dials without TLS/AUTH | sub via library `duplicate()` (identical options); single `buildOptions`; store ping-gated at startup | L | H | ACCEPT |
| W7-T27 | Credential leak via logs/metrics/errors | password in startup log, /metrics labels, client errors | password env→ioredis only; `describeConfig` carries `authConfigured` bool; enum-only labels; scoped `substring`-free log assertions in tests | L | H | ACCEPT |
| W7-T28 | Rematch vote forgery/collision | crafted gameId escapes the `rematch:` namespace | integer-only gameId + positive-int userId validated BEFORE key build; `keyForGame` throws otherwise; unit-tested incl. injection strings | L | M | ACCEPT |
| W7-T29 | Stale votes resurrect old rematches | unexpired sets fire quorum on a later game | 1h TTL refreshed per vote + explicit clear on new game + removal on departure; TTL is the backstop | L | M | ACCEPT |
| W7-T30 | Redis outage strands/DoSes the backend | CrashLoop/readiness-503 during cache maintenance | startup gate + readiness fail LOUD (alertable, visible); rematch fails closed with controlled error; maintenance-window behavior USER-SIDE-verified (baseline §Phase 3.5); retry/backoff strategy revisited pre-Phase 7 | M | M | ACCEPT (staging) |
| W7-T31 | Reconnect storm hides an incident | tight reconnect loop burns ECPUs silently | capped backoff (≤2s), `redis_reconnects_total` per client, reconnecting logged (redacted); ECPU throttle caps spend (W7-T19) | L | M | ACCEPT |
| W7-T32 | High-cardinality/metric-secret leak | per-game/user labels or secret values in series | label enums fixed in code (3 clients × 9 commands × 3 ops); no id labels (checker bans gameId/userId/socketId/roomId in metrics); catalog bounds worst case ≤243 series | L | M | ACCEPT |
| W7-T33 | Cross-replica rematch/user confusion | adapter delivers a vote event to the wrong replica's room | votes keyed by validated userId in ONE shared set (no per-replica sets to diverge); resolution still needs local presence — exact at 1 replica; multi-replica semantics explicitly Phase 4 (G4) | L | M | ACCEPT (1 replica) |
| W7-T34 | Shutdown drops in-flight Redis work | SIGTERM kills mid-command, corrupting counters | close path quits (drains) with 5s cap then force-disconnects; votes are idempotent SET adds; shutdown order unit-tested | L | L | ACCEPT |

## Phase 4 — DB-truth room cache (BUILT)

| # | Threat | Attack path | Mitigation (built) | L | I | Residual |
|---|---|---|---|---|---|---|
| W7-T35 | Stale room cache decides wrong | replica acts on pre-finish/pre-move state (wrong reject, dropped move, skipped finalize) | refresh-from-truth before EVERY mutation decision; persistence re-checks under row lock (accepts self-correct even if refresh missed); poison-heal unit-tested | L | M | ACCEPT |
| W7-T36 | Forked room objects split the op chain | concurrent cache misses build two objects, tasks interleave | in-flight hydration dedup (one object per room); refresh carries the chain onto rebuilt objects; concurrency-tested | L | M | ACCEPT |
| W7-T37 | Hydration abuse / socket-event flood | authed client spams random ids → DB reads; no socket throttle exists (pre-existing) | 7-char alphabet gate (malformed = zero DB hit); ONLY join hydrates (miss elsewhere = free); single snapshot query per miss; outcomes metric'd | M | L | ACCEPT (staging) + G5 |
| W7-T38 | Phantom presence starts/resolves games | stale adapter state shows ghosts; dead adapter blocks play silently | fetchSockets is a LIVE query, not cached state; any fault/timeout (3s) fails CLOSED (wait, don't start); `presence_checks_total{failed}` + warn; dead-adapter test proves loud-block | L | M | ACCEPT |
| W7-T39 | Rematch double-creation race | two replicas reach quorum simultaneously, create two games | atomic DB release (`room_id=NULL … status='finished'` — exactly one winner); loser errors while its client receives the winner's cluster-wide game_start; loser cache heals on next refresh; shape-tested | L | M | ACCEPT |
| W7-T40 | Transport breakage strands clients | polling blocked websocket-only server; middlebox-blocked websocket users can't play | polling fails LOUD (immediate 400, never hang); frontend pinned to match; accepted tradeoff with one-line-per-side rollback; USER-SIDE-verified | L | M | ACCEPT |
| W7-T41 | Stickiness creep ("to be safe") | well-meaning knob re-adds affinity + cookie interplay for zero benefit | REJECTED with recorded rationale (ADR-003 amendment); checker BANS `stickiness` annotations | L | L | ACCEPT |
| W7-T42 | Ended-replay leaks game facts | rejoiner sees result/winner they shouldn't | replay only to SEATED players (userId match on the finished game); result/winner already known to participants; ELO deltas never refabricated (`null`, UI-guarded) | L | L | ACCEPT |
| W7-T43 | Refresh fault orphans live rooms | DB blip evicts entries → forced rejoins, or leave lies about detaching | faults DON'T evict (entry kept, caller fails closed, next event retries); leave detaches+acks even without truth (finalize skipped, DB state kept); tested | L | L | ACCEPT |
| W7-T44 | Lingering cache entries (memory) | probed/rejected rooms pile up per finished game | join-only hydration + evict-socketless-on-reject + leave/disconnect evict finished+empty; bounded by live room ids (rematch NULLs old ones); lingering ~impossible, tested | L | L | ACCEPT |

## Phase 5 — shared rate limiting (BUILT)

| # | Threat | Attack path | Mitigation (built) | L | I | Residual |
|---|---|---|---|---|---|---|
| W7-T45 | Redis outage during attack (fail-open window) | outage overlaps credential-stuffing: auth budgets unenforced | FAIL OPEN + LOUD by design (metric per failed command, warn per limiter, `ChessRateLimitDegraded` ≤ ~10m, runbook abuse check); edge 20r/s still caps volume; tradeoff accepted (below) | M | M | ACCEPT (staging) |
| W7-T46 | Limiter key collision across scopes | shared client + sloppy keys: login counts register, or rematch ids collide | schema `ratelimit:{limiter}:{ip}` (7 disjoint prefixes) + disjoint `rematch:` namespace; no SCAN/KEYS; per-scope counts pinned by tests | L | M | ACCEPT |
| W7-T47 | X-Forwarded-For spoofing | attacker prepends victim IP: victim eats budget / attacker sheds theirs | ALB append-mode PINNED (Ingress annotation) + nginx real_ip recursive from VPC CIDR + validated backend trust=1: external attribution exact, spoofed prefixes never read. Residual: in-VPC origin self-attributes (inside trust boundary) | L | M | ACCEPT |
| W7-T48 | Trust-proxy misconfiguration | wrong hops => req.ip = ALB/nginx IP (global bucket) or spoofable position | TRUST_PROXY_HOPS validated (int 0-9, FATAL), Helm-pinned "1" with rationale, checker-pinned, XFF end-to-end test; misconfig fails LOUD (mass 429s, never silent bypass) | L | M | ACCEPT |
| W7-T49 | Replica fallback divergence | replicas disagree (local fallback while peer counts) | NO runtime fallback exists — proven 3 ways: same-IP-4x-past-limit test, no-MemoryStore-in-redis-path checker, passOnStoreError-only mechanism. Divergence impossible: shared truth or no counting | L | M | ACCEPT |
| W7-T50 | Limiter key flood / memory exhaustion | attacker mints buckets (IP rotation, IPv6) => Valkey memory/cost growth | TTL-bounded keys (≤15min, atomic SET+PX, sliding extension banned by checker); ~60B fixed schema; Serverless scales + Phase 2 cost ceilings (a cost blip, not an outage); no KEYS/SCAN | M | L | ACCEPT (staging) |
| W7-T51 | Fail-open abuse (attacker holds Redis down) | extended outage keeps auth unthrottled indefinitely | Valkey managed (AWS absorbs L3/4), SG allows EKS-only (no direct attacker path), edge limiter caps volume regardless, alert bounds detection, runbook abuse check + security-escalation path | L | M | ACCEPT (staging) |
| W7-T52 | IP-keying vs authenticated abuse | NAT collateral (one abuser 429s an office) + rotation bypass (botnets evade per-IP budgets) | limits generous for humans (documented inventory); no per-account budgets BY DESIGN (route endpoints are pre-auth; second keying = new design, deferred); rotation-scale defense is WAF territory (Wave 8) | M | L | ACCEPT (staging) |
| W7-T53 | Telemetry cardinality from limiting | per-IP/per-key series or log lines explode Prometheus/Loki | metric label = fixed 7-name enum (registry REJECTS identity names); logs carry {limiter, reason} enums only; adversarial-error tests prove zero IP/command leakage; no per-request limiter series on success | L | M | ACCEPT |
| W7-T54 | Misconfigured limits (DoS or open) | typo'd limit/window bricks login or silently unthrottles | limits preserved verbatim in ONE spec table; checker BINDS doc rows to code specs; 24 unit tests pin all 7 thresholds + 429 contract; any change needs code+doc+test sync | L | M | ACCEPT |
| W7-T55 | Limiter key/identity in logs or errors | Redis error text (embeds key+command) reaches logs/metrics/bodies | wrapper throws FRESH sanitized errors (originals dropped); logs {limiter, reason} only; bodies are static {error} strings; adversarial test asserts the IP appears NOWHERE observable | L | M | ACCEPT |

> ACCEPTED TRADEOFF (fail-open — W7-T45/W7-T51): when Redis is
> unavailable the limiter serves requests uncounted instead of rejecting
> them. A cache/coordination outage must not become a self-inflicted
> total outage — fail-closed would reject every login, registration,
> and refresh AND hand anyone who can disturb Valkey a full-DoS switch.
> The cost (a bounded brute-force window) is contained by the
> Redis-independent edge limiter, ≤ ~10m detection, and post-window
> abuse checks. Revisit only if auth gains per-account budgets (Wave 8+).

## Phase 6 — bounded graceful shutdown (BUILT)

| # | Threat | Attack path | Mitigation (built) | L | I | Residual |
|---|---|---|---|---|---|---|
| W7-T56 | Shutdown hang via HTTP/Socket.IO double-close | `io.close()` internally closes the attached server; a second `server.close()` hangs on keep-alive then errors | sole-closer design: application code NEVER calls the HTTP close (checker bans the literal); `io.close()` is the single call site; idle sweep + bounded race + one force-destroy; unit-pinned | L | M | ACCEPT |
| W7-T57 | New work admitted mid-drain corrupts in-flight state | requests/handshakes/packets land while chains unwind | 4 admission gates (HTTP 503 + `Connection: close`, handshake reject, fail-closed packet gate, roomTask backstop); listener stays open so rejections are fast, not refused connections | L | M | ACCEPT |
| W7-T58 | Pod reports Ready while termination already started | preStop sleep delays SIGTERM; readiness flips only after | trigger-then-sleep preStop: DRAINING at T+0 (readiness 503s immediately), 5s propagation, SIGTERM runs the 22s sequence; SIGTERM-alone converges identically | L | M | ACCEPT |
| W7-T59 | Remote drain trigger (single-request DoS) | attacker/compromised peer calls the drain endpoint | loopback-only (`127.0.0.1`/`::1` + mapped form, else 403); trigger can ONLY flip DRAINING, never run phases; unreachable via ingress (ALB→frontend only) | L | M | ACCEPT |
| W7-T60 | Chess operations silently dropped in drain | resolve-drop loses moves/resigns with no caller signal | controlled `ShutdownDrainError` rejection (existing per-caller handlers); chain object untouched; every gated socket packet still gets an error/ack — zero silent paths | L | M | ACCEPT |
| W7-T61 | Unbounded drain overruns grace → SIGKILL mid-write | slow poll/chain/pool holds the sequence past 30s | 22s global watchdog (exit 1) + every phase clamped to remaining; phase caps sum 21s + 1s slack; per-phase timeout/force is routine (exit 0) | L | H | ACCEPT |
| W7-T62 | Abandoned room ops corrupt game truth | drain expiry strands a half-written move/finalize | all chess writes are row-locked PG transactions (abort rolls back, locks release on disconnect); abandonment never cancels semantics; games recover on next boot | L | M | ACCEPT |
| W7-T63 | Coordination-client close wedges shutdown | quit hangs; socket teardown races closing clients | ordering socket→cache→pg (PG authority closes last); existing quit cap + force-disconnect + explicit clean/forced result; outer race clamps to remaining | L | M | ACCEPT |
| W7-T64 | Pool close hangs or double-ends | `pool.end()` waits on checked-out clients; second call rejects | exactly-once guard (module flag) + race against remaining budget; cap expiry proceeds to exit (server-side rollback on disconnect) | L | M | ACCEPT |
| W7-T65 | Duplicate signals re-enter the sequence | second SIGTERM/SIGINT or crash-during-drain corrupts phase state | single CAS controller (`process.on`, not `once`): duplicates ignored + counted (`shutdown_signals_total`); watchdog + SIGKILL remain the escape hatches | L | M | ACCEPT |
| W7-T66 | Liveness coupled to drain (restart storm on rollout) | draining pod restarts instead of exiting cleanly | liveness stays dependency-free and 200 throughout; ONLY readiness flips; probes byte-identical (checker pins periods/thresholds) | L | M | ACCEPT |
| W7-T67 | Shutdown telemetry leaks identity/secrets or explodes series | room ids, reasons, or error text in labels/logs | fixed enums only (3 sources × 6 phases × 3 results × 2 signals × 2 actions); logs carry phase/result/durations, never identities or secrets; catalog bounds ≤ 26 new series | L | M | ACCEPT |
| W7-T68 | Forced/timeout phases go unnoticed (silent degradation) | routine forces hide a progressively sicker drain | every force/timeout is a structured warn + `shutdown_phase_total{phase,result}` + per-phase durations; no new alert (routine forces are expected during deploys, not pageable) | M | L | ACCEPT (staging) |

## Open gates (later Wave 7 phases — NOT silently closable)

- G1 (W7-T18): CLOSED — adapter + rematch (Phase 3), the shared rate
  limiter (Phase 5: fail-open + LOUD contract, metric/log/alert,
  24 tests), and graceful shutdown/drain (Phase 6: bounded 22s
  RUNNING/DRAINING/STOPPING/STOPPED sequence, 4 admission gates,
  trigger-then-sleep preStop, 38 tests) are all done. G4 (replicas>1)
  REMAINS the Phase 7 gate — G1 closure does not open scale-out.
- G2: `chess-redis` consumption stays backend-only (checker asserts forever).
- G3: no game-state write path to Redis ever lands (review + checker).
- G4: HPA/replicas>1 only after G1 proven (Phase 7–9 gates).
- G5 (W7-T37, NEW in Phase 4): socket-event throttling is unevaluated —
  no per-socket/per-event limiter exists (pre-existing gap, made visible by
  hydration costing a DB read on join-miss). Staging-accepted; MUST be
  revisited (throttle design or explicit accept with data) before OR with
  the Phase 7 replica gate — a 2-replica flood surface is wider.
  UNCHANGED by Phase 5 (the HTTP limiter explicitly does not see socket
  events). Bounded follow-up (Phase 7 replica gate at the latest): EITHER
  ship per-socket/per-event throttling OR record an explicit data-backed
  accept — the join-miss DB cost is now measured
  (`room_hydrations_total`), so the decision will have data.

## Deliberately OUT of Wave 7 (deferred with reason)

Prod Redis sizing/failover drills (Wave 8), CMK for cache/SM (Wave 8),
cross-region replication (not planned), FQDN-aware egress lockdown (Wave 8),
Redis exporter (CloudWatch is authoritative — no demonstrated need).
