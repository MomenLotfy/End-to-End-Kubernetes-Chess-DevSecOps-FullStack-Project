# ADR-009 — Alloy as telemetry/log collection layer

- Status: accepted
- Date: 2026-09-22
- Deciders: platform review (gate)
- Related: docs/05-architecture-gate.md §2

## Context

Staging/prod need pod logs → Loki, K8s/node metrics → Prometheus, and an OTLP path for later —
without running three overlapping collectors (Promtail + exporters + OTel Collector).

## Problem

One agent or several? And where do control-plane/audit logs go (they can't go to Loki directly)?

## Options considered

1. **Grafana Alloy (single DaemonSet/Deployment)** → logs to Loki, metrics to Prometheus,
   OTLP receiver ready for the future SDK.
2. **Promtail + kube-prometheus-stack exporters** — works, but two agents and no OTLP story.
3. **CloudWatch-only** — no new agents, but split-brain querying (app vs infra), weak LogQL/PromQL
   UX, and cost at label cardinality.

## Decision

Option 1 for workloads, with a deliberate split: **Alloy+Loki+Prometheus+Grafana for everything
in-cluster**; **CloudWatch for EKS control-plane/audit + CloudTrail** (sources AWS owns).
OTel SDK sampling stays deferred (ADR scope: collector is OTLP-ready, app emits `request_id` +
`traceparent` propagation only).

## Consequences

- Positive: one agent to pin/upgrade; correlated logs+metrics in one Grafana; cheap S3-backed Loki.
- Negative: Loki label-cardinality discipline required (documented label budget); Alloy config is
  code (reviewed, tested in staging first).

## Migration implications

Compose keeps json-file rotation (no Alloy on the single host — burden unjustified). EKS staging
gets the full stack in Wave 6; dashboards ship as code with the monitoring chart values.
