# ADR-006 — GitHub Actions instead of Jenkins

- Status: accepted
- Date: 2026-09-22
- Deciders: platform review (gate)
- Related: docs/05-architecture-gate.md §3

## Context

The repo contains 3 Jenkinsfiles and Jenkins-server Terraform (always-on `t3.2xlarge`, SG opens
22/8080/9000 to the world, placeholder hosts, static `aws-key` creds). GitHub Actions workflows
exist but gate nothing. Builds are `npm` + `docker` — minutes-cheap, GitHub-native.

## Problem

One CI system must own build/test/scan. Running both doubles credential sprawl, maintenance, and
"which pipeline is truth?" confusion.

## Options considered

1. **GitHub Actions (+ OIDC) as sole CI; ArgoCD owns deploy** — no servers, short-lived creds,
   workflows versioned with code.
2. **Jenkins as sole CI** — self-hosted control, but controller/Agent/plugin/credential burden
   (~$200+/mo + maintenance) with no capability gain here.
3. **Both** — rejected: two truths, two secret stores, twice the audit surface.

## Decision

Option 1. Legacy Jenkins dirs archived to `legacy/` (after Wave 5 proves the replacement) with a
rationale README; their stage lists preserved as CI requirements input.

## Consequences

- Positive: zero CI servers to patch; OIDC removes static AWS keys; capped workflow set
  (`ci.yml`, `security.yml`, `release.yml`, `terraform-*.yml`).
- Negative: dependence on GitHub-hosted runners (mitigated: pinned action SHAs, least-privilege
  tokens, minutes budget alert).

## Migration implications

Resurrection trigger (documented, not planned): org air-gap/compliance mandate, or 3 months of
Actions spend exceeding Jenkins TCO — then Jenkins runs ephemeral agents only and never deploys.
