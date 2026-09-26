# ADR-004 — RDS instead of PostgreSQL inside EKS

- Status: accepted
- Date: 2026-09-22
- Deciders: platform review (gate)
- Related: docs/05-architecture-gate.md §6.1

## Context

The database is this app's concurrency source of truth (row locks, idempotent finalization,
authoritative ELO/scores). The legacy in-cluster StatefulSet embeds a 2-table init script and
no backup story — it cannot serve the 7-migration chain.

## Problem

Where should Postgres live for staging/prod: managed service or cluster-operated?

## Options considered

1. **RDS PostgreSQL 16** (Single-AZ staging `t4g.micro`; Multi-AZ prod `t4g.small`+, KMS, PITR 7d,
   Enhanced Monitoring, Secrets Manager rotation).
2. **In-cluster Postgres (StatefulSet/operator)** — full control, but the team owns backups, PITR,
   failover, upgrades, and 3am pages.
3. **Aurora** — better failover/storage scaling, higher base cost than the app's load justifies.

## Decision

Option 1. App needs zero code change (`DB_SSL=true` + RDS CA via ESO already supported).
Migrations run as an ArgoCD PreSync Job with the existing advisory-locked runner. RDS Proxy
deferred (app pool `max: 10`/pod suffices; revisit on connection-exhaustion evidence).

## Consequences

- Positive: backups/PITR/failover/encryption outsourced to AWS; RPO ≤ 5 min / RTO ≤ 2h achievable.
- Negative: largest steady-state bill next to EKS/NAT; Multi-AZ failover still drops connections
  (app retries + pool recovery cover it; drill it).

## Migration implications

Compose Postgres stays for dev/prod-today. Staging RDS seeded from sanitized snapshot; prod cutover
uses `pg_dump` custom-format + verify (same pattern as `scripts/restore-postgres.sh`), then DNS shift.
