# ADR-007 — Argo CD for GitOps CD

- Status: accepted
- Date: 2026-09-22
- Deciders: platform review (gate)
- Related: docs/05-architecture-gate.md §4

## Context

CD needs declarative deploys, drift correction, audit trail, and one-click rollback across
staging/prod. CI pushing with `kubectl` gives cluster-admin to pipelines and no drift control.

## Problem

Who deploys to clusters, and how are environment promotions represented?

## Options considered

1. **Argo CD App-of-Apps** reading a separate `chess-gitops` repo; release workflow commits digest
   bumps; staging auto-sync, prod manual promotion PR.
2. **CI `kubectl apply`** — simple, but privileged pipelines, no reconciliation, weak audit.
3. **Flux** — capable alternative; rejected on team familiarity + Argo's UI/audit for approvers.

## Decision

Option 1. Chart source lives in the app repo (OCI-packaged to ECR on release); env values +
digests live in `chess-gitops`. Sync waves: namespace → ESO secrets → migration PreSync Job →
backend → frontend → ingress. No ArgoCD Image Updater (commit-back is one auditable step).

## Consequences

- Positive: Git is the audit log; drift self-heals (alerted); prod rollback < 5 min; CI never
  holds cluster credentials.
- Negative: controller to run/upgrade; repo-creds + project RBAC to manage; prod auto-sync
  deliberately OFF (human promotion).

## Migration implications

Bootstrap order: chart → gitops repo → ArgoCD staging → soak → prod project. Emergency path:
ArgoCD revision rollback, then reconcile Git within 1h (Git stays truth).
