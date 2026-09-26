# ADR-008 — Kyverno for Kubernetes policy

- Status: accepted (audit first, enforce at Wave 8)
- Date: 2026-09-22
- Deciders: platform review (gate)
- Related: docs/05-architecture-gate.md §5

## Context

Admission control must guarantee non-negotiables (signed digest-pinned images, probes/limits,
non-root/seccomp, no `:latest`/privileged) regardless of who authors a manifest. PSS covers the
baseline but cannot verify Cosign signatures.

## Problem

Kyverno vs OPA/Gatekeeper vs PSS-only for a 2-service app with a small team?

## Options considered

1. **Kyverno, ≤5 policies** — Kubernetes-native YAML policies, `verifyImages` for Cosign,
   `kubectl`-friendly testing; lowest learning curve.
2. **OPA/Gatekeeper + Rego** — most expressive, but Rego burden unjustified at this scale.
3. **PSS-restricted only** — free and built-in, but no image-signature verification, weaker
   require-limits/probes expressiveness.

## Decision

Option 1 layered on PSS-restricted. Policy set (frozen until an incident justifies more):
(1) `verifyImages` (Cosign keyless) — prod enforce, staging audit→enforce;
(2) require digest (no tags, no `:latest`); (3) require probes + requests/limits;
(4) require `seccompRuntimeDefault`, drop ALL, non-root; (5) deny hostPath/hostNetwork/privileged.

## Consequences

- Positive: supply-chain enforcement at admission; readable policies in Git; CLI pre-check in CI.
- Negative: mis-scoped policy can block deploys — mitigated by audit-mode soak + break-glass
  ClusterRole (alerted, time-boxed) for emergencies.

## Migration implications

Install Wave 5 (audit), review violations weekly on staging, flip to enforce in Wave 8 only with
soak evidence. Policy changes follow the same PR + CODEOWNERS flow as chart changes.
