# ADR-001 — Docker Compose as current production baseline

- Status: accepted
- Date: 2026-09-22
- Deciders: platform review (gate)
- Related: docs/05-architecture-gate.md §7, docs/00-discovery.md §0.10

## Context

The supported deployment today is a single Linux host running `docker-compose.yml`
(Nginx → 1 backend → Postgres + migration job). The app's realtime state is process-local
(see ADR-002), so multi-node orchestration buys nothing until the scale-out work lands.
The Compose stack is already hardened (private network, health-gated startup, read-only
filesystems, dropped capabilities, log rotation, no DB host port).

## Problem

Should we keep Compose as the production runtime while building the EKS target, or freeze
it and rush the cluster?

## Options considered

1. **Keep Compose as prod, harden incrementally** — limits, backup off-host, runbook.
2. **Freeze Compose, rush EKS** — faster "cloud-native" label, but deploys an unproven stack.
3. **Compose forever, no EKS** — cheapest, but no declarative CD, manual failover, poor team scaling.

## Decision

Option 1. Compose remains the production runtime through Wave 6, receives hardening only
(Wave 1: resource limits, `init`, migration-name fix, encrypted off-host backups), and stays
available as instant DNS fallback during the Wave 8 cutover.

## Consequences

- Positive: stable prod during the build; every EKS behavior has a known-good reference;
  cutover risk collapses to a DNS weight change with rollback.
- Negative: two runtimes to maintain briefly during Waves 5–8; discipline needed so Compose
  doesn't drift from chart env contracts (mitigated: single env table in runbook).

## Migration implications

None destructive. Wave 8 shifts traffic ALB-ward; Compose host retained 30 days post-cutover
as rollback target, then decommissioned.
