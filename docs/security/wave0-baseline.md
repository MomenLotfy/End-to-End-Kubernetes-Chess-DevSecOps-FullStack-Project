# Wave 0 Security Baseline

Date: 2026-09-22 · Scope: repository + Git foundation only · Behavior change: **none**
Gate: `docs/05-architecture-gate.md` · Decisions: `docs/adr/001–010`

## 1. Secret sweep — classification (Wave 0 evidence)

Scanner: `detect-secrets scan --no-verify` over all tracked files (excluding new `docs/`),
plus `git grep` for AWS keys, GitHub tokens, private keys, Slack tokens across history
(history is a single squashed commit — tree scan == history scan).
Gitleaks binary could not be downloaded in this sandbox (release-asset CDN blocked);
`.gitleaks.toml` ships as the repo standard and runs in CI from Wave 2.

| # | Location | Signal | Classification | Disposition |
|---|---|---|---|---|
| 1 | `Chess-Backend/coverage/*` (tracked) | hex high-entropy | **False positive** — generated jest coverage hashes | Excluded in `.gitleaks.toml`; tracked-coverage cleanup candidate for Wave 1 |
| 2 | `Chess-Backend/tests/*.js:1`, `docker-compose.yml:91` | `*-secret-that-is-longer-than-thirty-two-characters` | **Test fixture** — descriptive low-entropy; integration suite refuses non-`*_test` DBs | Tight regex allow in `.gitleaks.toml` |
| 3 | `tests/auth.smtp.integration.test.js:55,89`, `e2e/tests/fullstack.spec.js:31` | `Correct-Horse-Battery-N`, `` Safe-${id}-Password! `` | **Test fixture** — Mailpit/e2e-only passwords | Tight regex allows in `.gitleaks.toml` |
| 4 | `monitoring/prometheus-values.yaml:12` | `adminPassword: "ChangeMe123!"` | **Placeholder default credential** (publicly known, not live) — must still be replaced | **NOT allowlisted**; covered by custom `chess-forbidden-placeholder-secret` rule; replaced in Wave 6 |
| 5 | `Chess-Backend/.env.example:10` | `-----BEGIN CERTIFICATE-----` placeholder comment | **Public/non-secret** — template documentation | No action |
| 6 | `docker-compose.yml` `${DB_PASSWORD:?…}` etc. | variable references, no values | **Non-secret** — indirection only | No action |

**Result: no live credentials in the repository. No rotation required. No STOP triggered.**

## 2. Dead security-sensitive code removed

`Chess-Backend/src/socket/socketAuth.js` — **deleted** (staged, this wave).

Proof of unreachability (all in §4 evidence commands):
1. Full `require()` inventory of `Chess-Backend/src/` — zero imports of `socketAuth`.
2. No dynamic `require(variable)` anywhere in `src/` (all callsites literal).
3. Zero references in `tests/`, `e2e/`, compose files, Dockerfiles, workflows.
4. Only matches repo-wide: the file itself, stale `full report.md` audit claims, and gate docs.
5. Live path confirmed: `server.js` → `gameSocket.js:initSocket` → local `socketAuthentication`
   (cookie + `verifyAccessToken` + DB `session_version`). Untouched in this wave.

Why deletion, not fix: the file allowed **guest (unauthenticated) sockets** and fell back to
`"chess-secret-key"` — a value `config/security.js` explicitly forbids at startup. Any future
import would silently downgrade socket auth. Deletion is behavior-neutral (verified by
unchanged backend test suite, §5).

Note: `full report.md` (prior audit) describes this file as live and flags `middleware/auth.js`
for the same fallback — both claims are stale: `auth.js` now verifies via `requireJwtSecret()`
which throws on missing/placeholder secrets. The stale audit is left intact as history.

## 3. Git security baseline

### 3.1 CODEOWNERS
`.github/CODEOWNERS` created. Owner `@MomenLotfy` verified via `gh repo view`
(personal public repo — no org teams exist to reference). Covers: app code, CI,
infra (legacy + future `terraform/`/`helm-chess/` paths pre-declared), security config.
Org migration note included in-file.

### 3.2 Branch protection — MANUAL ACTION REQUIRED (owner)
Sandbox token cannot manage protection (API: 403). Owner must run once (repo admin):

```bash
# 1) Require PR + 1 review + CODEOWNERS + strict status checks on main
gh api repos/MomenLotfy/End-to-End-Kubernetes-Chess-DevSecOps-FullStack-Project/branches/main/protection \
  -X PUT \
  -F required_pull_request_reviews[required_approving_review_count]=1 \
  -F required_pull_request_reviews[require_code_owner_reviews]=true \
  -F required_pull_request_reviews[dismiss_stale_reviews]=true \
  -F required_status_checks[strict]=true \
  -F required_status_checks[checks][]='ci' \
  -F enforce_admins=true \
  -F restrictions='null' \
  -F allow_force_pushes=false \
  -F allow_deletions=false
# 2) Verify
gh api repos/MomenLotfy/End-to-End-Kubernetes-Chess-DevSecOps-FullStack-Project/branches/main/protection --jq '{required_reviews, enforce_admins}'
```

Notes: `checks: ['ci']` activates when Wave 2 creates the `ci.yml` required check — until then,
protection enforces review + CODEOWNERS only (do not add a check name that doesn't exist yet).
Enable in Settings → Code security: secret scanning + push protection, Dependabot alerts
(Dependabot config ships this wave; platform alerts are the backstop).

### 3.3 Workflow permissions — INTENTIONALLY UNCHANGED (Wave 2 owns rewrites)
Finding: no workflow declares `permissions:` (all run with default token scope).
Not patched here because a blanket `contents: read` would **break** the Trivy SARIF uploads
(which need `security-events: write`). Wave 2 rewrites the workflows with per-job least privilege.
Tracked as residual gap R-G1 (§7).

### 3.4 Local guardrails
- `.pre-commit-config.yaml`: gitleaks protect (staged) + no-commit-to-branch(main/master) +
  whitespace/EOF hygiene + 500KB file cap. Lightweight by design; install is opt-in:
  `pip install pre-commit && pre-commit install`.
- `.github/pull_request_template.md`: per-wave security checklist (secrets, network, IAM,
  supply chain, attack surface, rollback) — enforces the every-wave DevSecOps rule.

## 4. `.gitignore` audit (this wave)

- Added `.env.*` (was: only `.env` + four `.local` variants — `.env.test`, `.env.staging`,
  `.env.production` were committable). Verified: all variants ignored, both `.env.example`
  templates still committable.
- Added `!docs/security/` negations (broad `*secret*` pattern would otherwise swallow the
  security docs dir). Verified: docs committable; `*-secret*`/`credentials*` files still ignored.
- `.pem/.key/.cert/.p12/.pfx`, `backups/`, `certs/`, `letsencrypt/`, `tests/certs/` already covered.

## 5. Supply-chain awareness (Wave 0 — inspect only, no upgrades)

- Package managers: npm only. Lockfiles present for all 4 roots
  (`Chess-Backend`, `Chess-Frontend`, `Database/migrations`, `e2e` has package.json; lockfile
  presence re-verified in Wave 2 with `npm ci` in CI).
- Pinning: backend/frontend deps exact-pinned; frontend carries security `overrides`. Good.
- Anomalies (documented, not touched — out of Wave 0 scope):
  - `Chess-Backend/Chess-Backend/package-lock.json` — tracked 82-byte stub, never read by npm.
  - Root `jest.config.js` + `jest.temp.config.js` — identical duplicates.
  - Tracked `Chess-Backend/coverage/` output — regenerable cruft.
  - `socket.io-client` in backend **dependencies** (likely test-only; verify before pruning).
- Dependabot (`.github/dependabot.yml`): weekly npm × 4 dirs + github-actions, capped PRs,
  no auto-merge. `npm audit` gating arrives in Wave 2 `ci.yml`.

## 6. Validation evidence (commands in final report)

- Backend unit suite (`npm test -- --runInBand`) green; frontend suite green; both builds green.
- detect-secrets sweep clean per classification table; `git status` shows Wave-0 files only.
- `.gitleaks.toml`/`pre-commit`/`dependabot` are declarative YAML/TOML — syntax-validated
  locally; live execution starts in Wave 2 CI (documented, not silent).

## 7. Residual gaps (explicitly NOT Wave 0)

- R-G1: workflows lack least-privilege `permissions:` → Wave 2 rewrite.
- R-G2: no required status checks until `ci.yml` exists → Wave 2.
- R-G3: branch protection needs owner action (§3.2) — cannot be done from sandbox.
- R-G4: secret push-protection / scanning toggles need owner action (Settings UI).
- R-G5: `ChangeMe123!` placeholder lives until monitoring wave → tracked, rule-guarded.
- Standing app/infra risks unchanged: single-process Socket.io state, local uploads,
  in-memory rate limits (all → Wave 7); legacy TF/K8s/Jenkins (→ Waves 4–5, then archive).
