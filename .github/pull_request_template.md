<!-- Wave 0 PR template: keep the security checklist honest. Delete sections that don't apply. -->

## What / Why

## Wave / ADR

- Wave: <!-- e.g. Wave 0 — Hygiene + Git -->
- ADR: <!-- e.g. ADR-002, or "none" -->

## Changes

- [ ] No application behavior change (or behavior change justified below)
- [ ] Docs updated (`docs/`, `docs/security/`, ADRs as needed)

## Security checklist (every wave)

- [ ] No secrets added (`.env`, keys, tokens, passwords) — gitleaks clean
- [ ] No new network exposure (ports, ingress, security groups)
- [ ] No IAM/permission broadening (workflows use least privilege)
- [ ] Supply chain: dependencies pinned; lockfile updated if manifest changed
- [ ] Attack surface: described below (or "unchanged")

## Validation

Commands run + results:

```text
# paste: tests, scans, builds
```

## Rollback

<!-- How to revert this PR safely. -->
