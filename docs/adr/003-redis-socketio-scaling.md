# ADR-003 — Redis for Socket.io horizontal scaling

- Status: accepted (timing-gated: Wave 7 only)
- Date: 2026-09-22
- Deciders: platform review (gate)
- Related: docs/05-architecture-gate.md §1–§2

## Context

Scale-out needs inter-pod pub/sub (Socket.io adapter), a shared rate-limit store, and nothing
else from Redis: game truth stays in Postgres (FEN + moves + status), sessions stay JWT + DB.

## Problem

Which shared-state substrate unlocks replicas ≥ 2 with minimum operational burden and no
idle spend before it's needed?

## Options considered

1. **ElastiCache Redis (prod) + small staging instance, deployed at Wave 7** — managed failover,
   backups, KMS; app uses `@socket.io/redis-adapter` + `rate-limit-redis`.
2. **Self-hosted Redis on EKS** — no service bill, but you own failover, persistence, upgrades.
3. **Postgres LISTEN/NOTIFY as pub/sub** — zero new infra, but wrong tool (no adapter support,
   connection/load semantics poor for fan-out).

## Decision

Option 1, with strict scoping: Redis holds **ephemeral pub/sub + rate-limit counters only**.
Companion app changes ship in the same gate: ALB stickiness, `userId`-keyed votes/membership,
lazy room hydration from DB, connection draining (`preStop` + 60s grace). No earlier: an idle
Redis bill with no traffic benefit is rejected.

## Consequences

- Positive: minimal new state to reason about; adapter is the vendor-blessed path; limits become
  globally correct.
- Negative: new failure domain (Redis outage degrades realtime + limits — design open-failover:
  limiters fail-closed on auth routes, adapter falls back to single-pod behavior with alert).

## Migration implications

Feature-flagged (`USE_REDIS_ADAPTER`) default OFF; staging proves 2-replica + pod-kill + split
traffic; rollback = flag OFF + prior digest. Later reuse (cache/queues) allowed only via new ADR.

## Amendment — Wave 7 Phase 4 (2026-09-22): ALB stickiness SUPERSEDED

The "ALB stickiness" companion change is REJECTED and replaced by
websocket-only transports (server + frontend pinned, polling refused with
an immediate 400). Reason: stickiness exists only to serve POLLING
transport affinity (per-process Engine.IO state the adapter cannot sync);
one long-lived websocket per client removes the affinity requirement
entirely — the ALB routes the HTTP upgrade once and never sees the client
again. Fewer knobs, no cookie interplay with `SameSite=Strict` auth, no
pinned-to-draining-pod edge, no polling overhead, zero infra change (ALB
+ nginx already speak `Upgrade`). Tradeoff (websocket-blocking
middleboxes can't play) accepted with one-line-per-side rollback.
Enforcement: `scripts/wave7-static-checks.py` §11 bans `stickiness`
annotations. See `docs/security/wave7-baseline.md` §Phase 4 (decision)
and gate §1.2 item 2 (pointer).
