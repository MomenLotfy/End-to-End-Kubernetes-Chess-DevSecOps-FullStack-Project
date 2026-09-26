# Wave 2 Security Baseline — Fail-Closed CI Gates

Date: 2026-09-22 · Scope: GitHub Actions CI only · App behavior: **unchanged**
Gate: `docs/05-architecture-gate.md` · Prior: `docs/security/wave1-baseline.md`

## 1. Legacy CI audit (what was there)

| Workflow | Verdict |
|---|---|
| `chess-backend-ci.yml` / `chess-frontend-ci.yml` | Near-identical; the only real gate was gitleaks. Trivy `exit-code: 0`, hadolint `no-fail: true`, eslint `|| true` (and no eslint config exists), no tests, no build. `trigger-jenkins` curled a Jenkins with long-lived user/token secrets (retired per ADR-006). Slack steps on every job. No `permissions:` blocks. Mutable `trivy-action@master`. **Replaced by `ci.yml`.** |
| `dependency-security.yml` | Scanned nonexistent `Chess-V1/`, `Chess-V2/` dirs and `YOUR_DOCKERHUB_USERNAME/*:latest` placeholder images — dead scaffold, required Docker Hub secrets that don't exist. **Replaced by `security-scheduled.yml`.** |
| `terraform-validation.yml` | fmt `continue-on-error`, deprecated tfsec `soft_fail`, `checkov@master` `soft_fail`, kubeconform via unpinned `latest` + `|| true`, PR comments needing write perms. Mixed signal, zero blocking. **Replaced by `infra-validation.yml`.** |

Preserved behavior: weekly audit cadence (Monday 09:00 UTC), SARIF uploads to code scanning,
7-day artifact retention, kubeconform strictness, terraform init-without-backend validation.

## 2. New pipeline

```text
PR → main ─┬─ secret-scan ──────── gitleaks + .gitleaks.toml (BLOCK)
           ├─ sast ─────────────── CodeQL javascript-typescript (BLOCK)
           ├─ sca ──────────────── 4 roots × npm ci + audit --omit=dev --audit-level=high (BLOCK)
           ├─ dependency-review ── fail_on_severity high, PRs only (BLOCK)
           ├─ test-backend ─────── npm ci + npm test -- --runInBand (BLOCK)
           ├─ test-frontend ────── npm ci + test + build (BLOCK)
           ├─ dockerfile-lint ──── hadolint, failure-threshold error (BLOCK)
           ├─ config-validate ──── compose YAML, gitleaks TOML, bash -n, node --check (BLOCK)
           ├─ build-and-scan ───── build 3 images + trivy image HIGH/CRITICAL (BLOCK)
           ├─ trivy-fs ─────────── vuln+misconfig HIGH/CRITICAL (BLOCK)
           └─ ci ───────────────── aggregator → THE required status check
push → main: same minus dependency-review (skipped counts as satisfied).
infra-validation: legacy TF + kubeconform, REPORT-ONLY with per-job flip conditions.
security-scheduled: weekly full audits + trivy-fs, informational, artifacts 30d/7d.
```

## 3. Severity & tool policies

| Gate | Blocks on | Informational | Accepted risk / FP process |
|---|---|---|---|
| Secrets (gitleaks) | any finding outside `.gitleaks.toml` allows | — | New allows require a classification row in this doc + reviewer approval; never silencers |
| SAST (CodeQL) | default query suite errors | warnings triaged in Security tab | First-run baseline is user-side; suppressions only via code comment with justification |
| SCA (`npm audit`) | high/critical in `--omit=dev` closure | full `--json` artifacts; weekly full audit | Frontend moderate (webpack-dev-server, dev-only, unshipped) — accepted, re-check on CRA replacement |
| dependency-review | newly introduced high+ | — | — |
| Hadolint | `error` threshold | warnings in logs | Escalate to `warning` only with justification + fix window |
| Trivy image/fs | HIGH/CRITICAL, `exit-code: 1` | — | `.trivyignore` requires CVE + expiry + reviewer; base-image rebuild cadence over ignores |
| Legacy TF/manifests | nothing (report-only) | summaries + artifacts | Flip to blocking: `terraform/` in Wave 4, `helm-chess/` in Wave 5 |

Single-config rules enforced: secrets owned solely by gitleaks (trivy `scanners: vuln,misconfig`
excludes secret); one Dependabot config; one CODEOWNERS. No SonarQube (unjustified weight),
no Checkov (trivy-config covers), no tfsec (deprecated), no second secret scanner.

## 4. Permissions & supply-chain model

- Top-level `permissions: {}` on every workflow; per-job least privilege. Only `write` in the
  estate: `security-events: write` on SAST/SARIF jobs. No `contents: write`, no `actions: write`
  (upload-artifact uses artifact-service credentials under `contents: read`), no `pull-requests: write`.
- GITHUB_TOKEN is the only secret referenced (`secrets.GITHUB_TOKEN` for gitleaks). Jenkins,
  Slack, and Docker Hub secrets are gone with the legacy workflows — rotate/delete them in
  repo Settings (owner action; they are now unused).
- All 13 third-party action refs pinned to full commit SHAs (release tag in trailing comment);
  resolved 2026-09-22 via release API. Dependabot `github-actions` (Wave 0) proposes updates.
- Fork-PR safety: `pull_request` trigger (read-only token, no secrets); SARIF uploads guarded by
  `!github.event.pull_request.head.repo.fork` with artifact fallback; no `pull_request_target`;
  no interpolated untrusted input in `run:` blocks (only `matrix.*`/`github.sha` controlled values).
- kubeconform installed from a pinned release with sha256 verification (replaces `latest` + sudo pipe).

## 5. What CI must never publish

Artifacts are limited to audit JSON, SARIF, kubeconform JSON (7d; weekly audit 30d).
No `.env`, keys, passphrases, dumps, or production config can reach artifacts: none exist in
the checkout (git-ignored), and no job handles credentials. Gitleaks runs with `--redact`
behavior via the action default; SARIF contains findings metadata, not secret values.

## 6. Required checks (owner action)

Branch protection on `main` must require the **`ci`** status check (aggregator) + 1 review +
CODEOWNERS (commands in wave0 baseline §3.2; add `-F required_status_checks[checks][]='ci'`).
Do NOT require `infra-validation` or `security-scheduled` (report-only / scheduled). Verify after
merge with `gh api .../branches/main/protection --jq .required_status_checks`.

## 7. Threat / control / residual-risk matrix

| # | Threat | Attack surface | Pre-Wave-2 exposure | CI control (this wave) | Validation | Residual risk | Rollback |
|---|---|---|---|---|---|---|---|
| 1 | Secret merged to main | PR diff | gitleaks only, Jenkins-era config | gitleaks + repo `.gitleaks.toml` + custom placeholder rule, blocking | YAML valid; live run user-side | history contains pre-gate commits — shallow clone limits blast radius; push-protection toggle is owner action | revert workflow |
| 2 | Vulnerable dependency merged | manifests | `|| true` audits on phantom dirs | per-root `npm ci` + high+ block; dependency-review on PRs | 4/4 blocking audits exit 0 locally | moderate/low pass by policy; transitive-only review limits | revert workflow |
| 3 | Malicious dependency update | Dependabot/PR | no review gate | dependency-review + CODEOWNERS + required `ci` | config valid; live run user-side | sophisticated backdoor below severity radar — accepted, SBOM in Wave 3 improves | revert PR |
| 4 | Malicious PR exfiltrates secrets | runner | Jenkins/Slack secrets exposed to all runs | zero long-lived secrets in CI; fork-safe token handling | secret grep: only GITHUB_TOKEN | self-hosted runners not used — GitHub-hosted ephemerals | revert workflow |
| 5 | Compromised action version | supply chain | `@master`, `@latest` | full-SHA pins + Dependabot proposals | all 13 refs verified 40-char SHA | SHA maintains integrity, not action-repo compromise — review Dependabot diffs | pin prior SHA |
| 6 | Workflow privilege escalation | GITHUB_TOKEN | default broad perms | top-level `{}` + per-job least privilege | asserted in validation script | `security-events: write` is required for SARIF — minimal and scoped | revert workflow |
| 7 | CI script injection | `run:` blocks | PR-comment interpolation patterns | no untrusted interpolation; matrix/sha values only | manual review of all `run:` | `${{ github.* }}` in `run:` limited to aggregator JSON dump (not executed) | revert workflow |
| 8 | Unsafe Dockerfile merged | images | `no-fail: true` | hadolint error-threshold block + real `docker build` | YAML valid; build+lint live user-side | warnings non-blocking by policy — triage in logs | revert workflow |
| 9 | Vulnerable base image | images | `exit-code: 0` scans | trivy image HIGH/CRITICAL block on all 3 prod images | live run user-side | first-run baseline unknown — triage on green/red signal | `.trivyignore` w/ expiry (justified only) |
| 10 | Insecure infra config merged | TF/manifests | soft-fail everything | report-only + summaries + flip conditions (Waves 4-5) | YAML valid; live run user-side | legacy stays non-gating by decision — time-boxed by roadmap | n/a (informational) |
| 11 | Artifact/log leakage | artifacts | SARIF without declared perms | minimal artifact set, 7d retention, no creds in checkout | artifact path review | SARIF metadata only — no secret values | delete artifacts |
| 12 | Gate bypass (admin/merge) | branch | no protection verified | single `ci` required check design | owner must enable protection | unenforced until owner acts — tracked, not assumed | enable protection |

## 8. Validation record (this wave)

Locally executed: workflow YAML parse + permission assertions (3/3); backend 17/17;
frontend 16/16 + build; blocking `npm audit` exit 0 on all 4 roots; bypass grep
(only justified hits: informational `|| true` on report artifacts, documented
`continue-on-error` in infra-validation, `exit-code: 0` on report-only/scheduled);
40-char SHA audit on all 13 refs; secret grep (only GITHUB_TOKEN).
NOT RUN (environment limitation): any GitHub-hosted execution — gitleaks/CodeQL/trivy/
hadolint/docker-build/dependency-review/terraform/kubeconform live runs.
USER-SIDE: merge, confirm green `ci` on first PR, then enable branch protection (§6);
triage any first-run findings (expected-zero) and rotate/delete unused Jenkins/Slack/DockerHub secrets.
