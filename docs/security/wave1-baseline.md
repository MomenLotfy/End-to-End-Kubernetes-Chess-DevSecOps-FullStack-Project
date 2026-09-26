# Wave 1 Security Baseline — Production Compose Hardening

Date: 2026-09-22 · Scope: container/compose/backup hardening only · App behavior: **unchanged**
Gate: `docs/05-architecture-gate.md` · Prior: `docs/security/wave0-baseline.md`

## 1. Discovery summary (pre-change state)

| Area | Finding |
|---|---|
| Compose | 5 services, private bridge, health-gated deps, ro-fs + caps-drop on 4/5, no resource limits, no `init`, backend/frontend/postgres `unless-stopped` |
| Dockerfiles | backend multi-stage non-root; frontend builder + unprivileged nginx; migration single-stage non-root; no OCI labels; floating tags |
| .dockerignore | adequate (node_modules, coverage, build, `.env*`, TF/Jenkins dirs); root context missed `*.pem/*.key` |
| Nginx | TLS 1.2+, HTTP→308, HSTS (443 only), strict CSP (WASM-safe), rate limit on `/api`, WS upgrade correct, `server_tokens off` |
| Secrets | all via `${VAR:?}`/`${VAR:-}` env; no hardcoded values; `.env` 0600 by runbook; TLS keys bind-mounted ro (101:101, 0600 privkey) |
| Backup | local-only unencrypted `.dump` + sha256, catalog verified; restore script **expected 7 migrations but 8 files exist — verification always failed** |
| Migration chain | 8 files on disk; backend asserts 7 named; integration test asserted 7 names (red by logic); restore asserted count 7 (red by logic) |
| Supply chain | backend/migrations `npm audit`: 0 vulns; frontend: 2 moderate, dev-only (webpack-dev-server via react-scripts, never shipped) |

Sandbox has no Docker daemon: image builds, compose up, and runtime probes were **not**
executable here. Every runtime-affecting change below is conservative + reversible, and §8
gives the exact Docker-host validation commands that must run before this is called done.
Nothing here was marked "tested" that was not executed.

## 2. Migration "006" mini-report — DECISION: DO NOT RENAME

**Identity mechanism:** `run.js` keys `schema_migrations.filename` (PK) + SHA-256 per file;
applies `readdirSync` filtered by `/^\d{3}_.+\.sql$/`, lexical sort, one tx per file, advisory
lock `724337771`. Changed-content-after-apply aborts; unknown filenames apply as new.

**Current sequence (lexical = apply order):**
`001, 002, 003, 004, 005, 006_add_game_board_fen, 006_security_integrity, 007` — 8 files.
Order between the two `006` files is already deterministic and **not load-bearing**
(neither references the other's objects; `board_fen` is consumed only by app code).

**Applied-state analysis:** any environment that ran the migration service has **8 rows**
(the runner has no exclusion mechanism). Backend `assertMigrationsComplete` filters by 7
names (excludes the fen file) so it passes; readiness needs only the `007` row, which
implies the full sequential chain ran. The three "7" expectations (integration test,
restore script, README) were stale the moment the 8th file landed — the *files* are
correct, the *expectations* were wrong.

**Risk of rename:** on applied DBs the old row orphans (harmless but polluting) and the new
name re-executes (idempotent SQL, so harmless) — zero functional benefit for permanent
history divergence between old and fresh DBs. Renaming buys cosmetics at the cost of the
one thing migration history must never lose: single lineage.

**Remediation (implemented, all non-destructive):**
1. No file renamed, none modified. Filenames frozen by policy; next migration is `008+`.
2. `tests/postgres.integration.test.js`: expect all 8 names in order (test correctness fix).
3. `scripts/restore-postgres.sh`: expected count derived from files on disk (never hardcoded again).
4. README: file list + counts corrected to eight.
5. Deferred (app change, later wave): adding the fen filename to the backend's 7-name assert.
   Safe to defer: sequential runner + `007` gate already implies the full chain.

## 3. Changes (Wave 1 commit)

| File | Change | Why |
|---|---|---|
| `docker-compose.yml` | `name: chess`; `mem_limit/cpus/mem_reservation/pids_limit` on all services; `init: true` on node services; postgres `stop_grace_period: 30s`; header comment (topology + ADR-002) | DoS guardrails, deterministic naming, clean PID1 shutdown |
| `Chess-Backend/Dockerfile` | OCI labels + `ARG GIT_SHA`; `ENV NODE_ENV=production` default | Provenance; standalone runs fail closed (compose overrides explicitly — no behavior change) |
| `Chess-Frontend/Dockerfile`, `Database/migrations/Dockerfile` | OCI labels + `ARG GIT_SHA` | Provenance; digest-pin note |
| `.dockerignore` | `**/*.pem`, `**/*.key`, `**/*.passphrase` | Defense in depth for root-context builds |
| `.gitignore` | `*.passphrase` | Passphrase files can never enter git even if misplaced in repo |
| `scripts/backup-postgres.sh` | AES-256-CBC/PBKDF2 encryption (fail-closed on missing/group-readable passphrase), pre-encryption catalog verify, sha256 manifest, `BACKUP_OFFHOST_DIR` second copy + verify, `BACKUP_KEEP_DAYS` prune (default 14) | Encrypted, redundant, pruned backups; failures fatal |
| `scripts/restore-postgres.sh` | `.dump.enc` decrypt path, legacy `.dump` still readable, dynamic expected-count from disk | Fixes always-failing verification; supports new format |
| `tests/postgres.integration.test.js` | expect 8 migration names | Suite was red by logic; test-only fix |
| `README.md` | 8-file list, backup passphrase setup, off-host/retention docs | Operator accuracy |
| `Chess-Backend/coverage/` | untracked from git (files stay on disk) | Regenerable cruft; `.gitignore` blocks re-adding |

**Deliberately NOT changed:** `nginx.conf` (audit §5; zero findings worth untested edits),
`server.js` 7-name assert (app change — deferred per §2.5), base-image tags (digest pinning
needs a Docker host to resolve/verify — commands in §9), legacy TF/Jenkins/K8s files (Waves 4–5).

## 4. Secrets posture (Wave 1)

- Compose: `${DB_PASSWORD:?}`, `${JWT_SECRET:?}`, `${APP_ORIGIN:?}`, `${SMTP_HOST:?}`,
  `${EMAIL_FROM:?}` required; SMTP user/pass optional-empty (relay-dependent); no values in git.
- Why env-based (not Compose `secrets:`): on a single host, file-mounted secrets are the same
  disk with more indirection — no security gain. Real upgrade is Secrets Manager + ESO on EKS
  (later waves). Documented, not deferred by accident.
- Backup passphrase: file outside repo, 400/600 enforced by script, never logged, git-ignored
  by pattern. TLS keys: ro bind mounts, 0600 privkey owned by nginx uid 101.
- Verified: `git grep` for `AKIA|ghp_|BEGIN .*PRIVATE KEY|xox` across history — only the known
  `.env.example` placeholder comment (Wave 0 finding #5, non-secret).

## 5. Nginx audit (review-only; no edits)

| Check | Status |
|---|---|
| TLS 1.2/1.3, session cache, tickets off | ✅ keep |
| HTTP→308, HSTS on 443 only | ✅ keep |
| CSP (`wasm-unsafe-eval` required by Stockfish), COOP/COEP, frame deny, nosniff | ✅ keep — do not weaken |
| `/api` rate limit 20r/s + burst, 2m body cap, proxy timeouts | ✅ keep |
| `/socket.io` upgrade headers, `proxy_buffering off`, cookie passthrough | ✅ keep |
| Findings deferred for runtime-validated change | (a) `add_header` in `/static/` + `/stockfish/` locations shadows server-level security headers on subresource responses — negligible (document response carries policy), fix by repeating headers, validate with `curl -I` on Docker host; (b) optional `/socket.io/` handshake `limit_req` — validate against reconnect storms first |

## 6. Supply chain (Wave 1 baseline for Wave 2 automation)

| Signal | Result | Disposition |
|---|---|---|
| `npm audit --omit=dev` backend | 0 vulns | clean |
| `npm audit` migrations | 0 vulns | clean |
| `npm audit --omit=dev` frontend | 2 moderate (webpack-dev-server GHSA-9jgg/4v9v/79cf/mx8g/f5vj/m28w) | **Advisory / accepted risk**: dev-server only, never in the nginx runtime image; fix requires breaking react-scripts replacement ( CRA 5 EOL track — later wave) |
| Image scan / Hadolint / Trivy | not available in sandbox (no daemon, registry + release CDNs blocked) | **Wave 2** CI gates; Dockerfile changes kept minimal in the meantime |
| Base-image freshness | `node:22-alpine`, `postgres:16-alpine`, `nginx-unprivileged:1.27-alpine` current majors | digest pin on Docker host (§9), then Dependabot/docker updates |

## 7. Threat / control / residual-risk matrix

| # | Threat | Attack surface | Pre-Wave-1 exposure | Control (this wave) | Validation | Residual risk | Rollback |
|---|---|---|---|---|---|---|---|
| 1 | Secret leakage via git | repo, images | `.env.*` variants committable | `.env.*` blanket, `*.passphrase`, dockerignore keys, passphrase-permission gate | `git check-ignore` matrix (Wave 0) + grep sweep | operator error outside git (`.env` perms) — runbook | `git revert` |
| 2 | Container breakout / privesc | runtime | already ro-fs + caps-drop + no-new-privs | kept; `init:true` for signal hygiene; no new privs anywhere | compose YAML parse; runtime check on host §8 | postgres image runs entrypoint as root (upstream pattern) — constrained, accepted | `git revert` + `up -d` |
| 3 | Resource-exhaustion DoS | backend (Sharp), pg | unlimited | mem/cpu/pids guardrails | host: `docker stats` + avatar-upload soak §8 | limits are starting values — tune from metrics | remove limits, `up -d` |
| 4 | Exposed PostgreSQL | network | none (private net, no ports) | unchanged, re-verified | host: `nmap`/connect refusal §8 | none known | n/a |
| 5 | Malicious HTTP / WS abuse | Nginx→backend | rate limits present | unchanged (audited §5) | host: 429 smoke + WS e2e §8 | socket.io handshake unlimited — deferred w/ plan | n/a |
| 6 | Upload abuse | backend Sharp pipeline | validated pipeline | unchanged (behavior freeze) | existing e2e avatar tests on host | Sharp CVEs — image rebuild cadence (Wave 2) | n/a |
| 7 | Backup loss / theft | `backups/` | local-only plaintext | AES-256-CBC + sha256 + off-host copy + prune | roundtrip test ✓, guard-exit tests ✓, host: full cycle §8 | off-host dir unset → warned, not fatal (owner action) | legacy `.dump` still restorable |
| 8 | TLS misconfig | Nginx | strong | untouched | host: `nginx -t` + `curl -I` §8 | none known | `git revert` |
| 9 | Migration corruption | runner + history | 8 files vs "7" checks | expectations fixed, filenames frozen, dynamic count | `node --check`, count derivation = 8 ✓ | backend 7-name assert still excludes fen file — safe (sequential + 007 gate), deferred | `git revert` |
| 10 | Vulnerable deps/images | supply chain | unknown baseline | audit baseline recorded; labels for provenance | `npm audit` ✓ | webpack-dev-server advisory; image scan → Wave 2 | `git revert` |

## 8. Docker-host validation plan (MUST run before Wave 1 sign-off)

```bash
git checkout arena/01a0c5c2-end-to-end-kubernetes-chess-de && git pull
cp .env.example .env && chmod 600 .env  # fill JWT_SECRET/DB_PASSWORD/APP_ORIGIN/SMTP
openssl rand -base64 32 > ~/.chess-backup-passphrase && chmod 600 ~/.chess-backup-passphrase
export BACKUP_PASSPHRASE_FILE=~/.chess-backup-passphrase
docker compose config --quiet && docker compose up -d --build
docker compose ps && docker compose logs chess-migration --tail=5  # expect APPLIED/SKIP x8, COMPLETE count=8
docker compose exec chess-backend wget -qO- http://127.0.0.1:5000/readiness
docker compose exec chess-frontend nginx -t
curl -skI https://localhost/liveness | head -3
docker stats --no-stream  # confirm limits present, usage sane
BACKUP_OFFHOST_DIR=/mnt/offhost/chess scripts/backup-postgres.sh  # expect .dump.enc + verified copy
scripts/restore-postgres.sh backups/chess-*.dump.enc  # expect "Restore verified ... (8 migrations)"
docker compose --profile test run --rm postgres-integration-tests  # expect green incl. 8-name test
scripts/run-e2e.sh  # full HTTPS/browser/SMTP/two-client suite incl. WS + avatars
# negative checks:
python3 -c "import socket; socket.create_connection(('127.0.0.1',5432),3)"  # expect refused (pg internal)
for i in $(seq 1 60); do curl -sk -o /dev/null -w "%{http_code}\n" https://localhost/api/leaderboard; done | sort | uniq -c  # expect 429s under flood
```

## 9. Deferred with exact trigger (not dropped)

- **Digest pinning**: on Docker host —
  `docker buildx imagetools inspect node:22-alpine --format '{{.ManifestDigest}}'` (repeat per
  base), then `FROM node:22-alpine@sha256:<digest>`. Deferred: registry API blocked here; a
  wrong hand-written digest breaks all builds.
- **Backend 8-name assert**: one-line app change + e2e proof; needs runtime to prove safety.
- **Nginx header repetition + socket.io limit**: additive, but every nginx edit needs `nginx -t`
  + `curl -I` + WS e2e before merge.
- **Image scanning / Hadolint / Trivy**: Wave 2 CI gates.
- **Off-host destination**: owner provisions mount; script already consumes `BACKUP_OFFHOST_DIR`.
