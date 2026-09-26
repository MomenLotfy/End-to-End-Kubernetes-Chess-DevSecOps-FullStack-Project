# ADR-002 — Backend single replica until shared state is introduced

- Status: accepted
- Date: 2026-09-22
- Deciders: platform review (gate)
- Related: docs/05-architecture-gate.md §1

## Context

`gameSocket.js` keeps rooms in an in-memory Map, serializes per-room work in a local promise
chain, keys votes/membership by ephemeral `socket.id`, and broadcasts only within the process.
Rate limits (MemoryStore) and avatars (local disk) are likewise process-local. The DB layer is
already concurrency-correct (`SELECT … FOR UPDATE`, idempotent finalization), but realtime
fan-out is not.

## Problem

Any replica count ≥ 2 today causes silent cross-pod games, "Room not found" errors, deadlocked
rematches, multiplied rate-limit budgets, and 404 avatars. The legacy manifests set `replicas: 2`.

## Options considered

1. **Enforce `replicas: 1` now, scale at the Scale-Out Gate** — honest constraint, documented.
2. **Scale now with sticky sessions only** — fixes transport affinity, not fan-out/votes/limits/uploads.
3. **Shard rooms by pod** — custom router complexity for a 2-player game; rejected outright.

## Decision

Option 1. Backend runs exactly 1 replica (`Recreate` strategy, no HPA, no PDB — a PDB on 1
replica blocks drains) in Compose and early EKS. The Helm chart validates `replicaCount == 1`
until the scale-out values file is explicitly enabled at the gate.

## Consequences

- Positive: correct behavior everywhere; rolling updates are brief reconnects (client auto-rejoins;
  DB is truth), not corruption.
- Negative: no pod-level redundancy for the backend until Wave 7; node failure = ~1–2 min
  reschedule + client rejoin. Accepted and SLO-scoped (99.5%).

## Migration implications

Wave 7 flips the constraint (ADR-003 + ADR-005 + draining + HPA/PDB). The `replicaCount == 1`
chart guard is removed only in the same release that enables the Redis adapter + S3 reads,
proven by 2-replica staging tests.
