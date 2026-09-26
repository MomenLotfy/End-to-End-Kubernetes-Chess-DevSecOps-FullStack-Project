# Phase 0 — Complete Project Discovery

Date: 2026-09-21 · Branch: `arena/01a0c5c2-end-to-end-kubernetes-chess-de` · Commit base: `f5c7cb3`

This document is ground truth derived from reading the repository. No assumptions.

## 0.1 Repository structure

```text
.
├── Chess-Backend/            # Node 22 / Express 4 / Socket.io 4 API + realtime server
│   ├── src/
│   │   ├── server.js         # app factory, middleware chain, probes, shutdown
│   │   ├── config/           # db.js (pg pool), security.js (env validation), logger.js (winston)
│   │   ├── middleware/       # auth.js (JWT+session), originProtection.js, upload.js (avatar)
│   │   ├── models/           # User, Game, Move, Score, Tournament, Friendship, Achievement, AuthToken
│   │   ├── routes/           # auth, game, leaderboard, friends, tournaments
│   │   ├── services/         # mail.js (nodemailer), tokens.js
│   │   ├── socket/           # gameSocket.js (rooms, moves, resign, rematch, chat), socketAuth.js
│   │   └── utils/elo.js
│   ├── tests/                # unit + postgres integration + concurrency + smtp tests
│   ├── Dockerfile            # multi-stage, non-root 1001, HEALTHCHECK
│   └── package.json          # pinned deps, jest configs
├── Chess-Frontend/           # React 18 (react-scripts 5) SPA + Stockfish WASM (same-origin)
│   ├── src/                  # App.js composition; api/, components/, hooks/, engine/, contexts/
│   ├── nginx.conf            # unprivileged nginx: TLS, HSTS, CSP, proxy /api /uploads /socket.io
│   ├── Dockerfile            # node build → nginxinc/nginx-unprivileged:1.27-alpine
│   └── package.json          # pinned deps + overrides for CVEs
├── Database/migrations/      # 001..007 SQL + run.js (advisory lock, checksum, ordered tx)
│   └── Dockerfile            # one-shot migration image (node:22-alpine, non-root)
├── docker-compose.yml        # PRODUCTION single-server stack (postgres, migration, backend, frontend)
├── docker-compose.test.yml   # e2e override (mailpit, self-signed certs, browser-e2e)
├── Manifest-file/            # legacy K8s YAML (backend/frontend/postgres/infra) — STALE, see §0.9
├── EKS-TF/                   # legacy Terraform for EKS (single public-subnet design) — STALE
├── Jenkins-Server-TF/        # legacy Terraform for Jenkins EC2 (t3.2xlarge) — STALE
├── Jenkins-Pipeline-Code/    # 3 Jenkinsfiles (backend, frontend, EKS terraform) — STALE/PARTIAL
├── .github/workflows/        # 4 workflows (backend-ci, frontend-ci, dependency-security, terraform-validation)
├── monitoring/               # kube-prometheus-stack values + ServiceMonitor — STALE refs
├── scripts/                  # provision-https.sh, renew-https.sh, backup/restore-postgres.sh, run-e2e.sh
│                             # + legacy bootstrap.sh / install-argocd.sh / install-monitoring.sh / cleanup.sh
├── e2e/ + tests/             # Playwright HTTPS/browser/SMTP/two-client suite + integration Dockerfile
├── SECURITY.md / README.md   # single-server production contract (1 backend replica, HTTPS-only)
└── Makefile                  # legacy Arabic-label EKS/ArgoCD/monitoring targets — STALE
```

## 0.2 What the application actually does

Full-stack real-time chess platform:

- **Local play** (same browser), **AI play** (Stockfish WASM, client-side, same-origin `/stockfish/`),
  **online multiplayer** (Socket.io rooms: create/join/move/resign/rematch/chat/reconnect).
- **Accounts**: register → email verification → login (HttpOnly cookies) → refresh rotation →
  logout-all-sessions, forgot/reset password (revokes sessions + refresh family).
- **Social/competitive**: friends (request/accept/decline), leaderboard + ELO, tournaments
  (create/join/start/report), achievements, game history/replay, stats.
- **Avatars**: 2 MB upload → full container validation → Sharp decode → strip metadata →
  resize → random WebP filename on persistent volume; authenticated reads only.
- **Authoritative server**: moves validated with `chess.js` under a Postgres game-row lock;
  completion + ELO + scores + achievements committed in **one transaction** guarded by status
  transition. Client-submitted results/scores/ELO are **rejected** (`POST /api/game/save` → 403).

## 0.3 Components and communication (actual)

```text
Browser (React SPA, served by Nginx)
  │  HTTPS :443 (public) ──► Nginx :8080/:8443 (container, unprivileged 101)
  │                             ├── /api/*        → chess-backend:5000 (HTTP, keepalive)
  │                             ├── /uploads/*    → chess-backend:5000 (auth required)
  │                             ├── /socket.io/*  → chess-backend:5000 (WS upgrade, buffering off)
  │                             ├── /liveness,/readiness → backend probes
  │                             └── /*            → static React build + /stockfish/* WASM
  │
chess-backend (Node 22, non-root 1001, read-only FS)
  ├──► chess-postgres:5432 (pg pool, max 10, statement timeout 10s)
  └──► SMTP submission (default :587 STARTTLS, TLS verify on) for verify/reset emails

chess-migration (one-shot, before backend): applies 001..007 with advisory lock + SHA-256 checksums
chess-postgres (postgres:16-alpine, private bridge network, NO host port)
```

**Dependency map (actual):**

```text
Frontend (React static)
  → Nginx (TLS termination, reverse proxy, static)
    → Backend API (Express REST + Socket.io)
      → PostgreSQL 16 (users, games, moves, scores, ELO, friends, tournaments, achievements, tokens, migrations)
      → SMTP (external submission server; Mailpit only in e2e override)
      → uploads_data volume (WebP avatars)
```

No Redis, no queue, no worker, no object storage, no external game API. All realtime state
(room membership, queues, rematch) is **process-local** → exactly **1 backend replica** is mandatory.

## 0.4 Ports and protocols

| Component | Port (container) | Port (host) | Protocol | Exposure |
|---|---|---|---|---|
| Nginx | 8080 / 8443 | 80 / 443 | HTTP→308 redirect / HTTPS+HTTP/2+WSS | public |
| Backend | 5000 | none (`expose` only) | HTTP + WebSocket (`/socket.io/`) | compose network only |
| Postgres | 5432 | none | PostgreSQL wire | compose network only |
| Mailpit (e2e only) | 1025 / 8025 | none | SMTP / HTTP | compose network only |
| Playwright (e2e only) | — | none | runs inside network | — |

Public surface = **80/443 only**. Correct minimal design.

## 0.5 Environment variables (required in production)

Backend validates at startup and **refuses to boot** on misconfiguration:

| Var | Required | Notes |
|---|---|---|
| `JWT_SECRET` | yes (≥32 chars, placeholders forbidden) | access JWT + session version |
| `APP_ORIGIN` → `FRONTEND_URL` | yes, exact `https://…`, no trailing slash | CORS + Origin allowlist |
| `DB_HOST/DB_NAME/DB_USER/DB_PASSWORD` | yes | `DB_SSL=true` + `DB_SSL_CA` when DB leaves private net |
| `SMTP_HOST`, `EMAIL_FROM` | yes | `SMTP_PORT` 587 default, `SMTP_REQUIRE_TLS=true`, verify on |
| `NODE_ENV=production`, `PORT=5000`, `TRUST_PROXY_HOPS=1` | set by compose | trust proxy exactly 1 hop (Nginx) |
| `JWT_ACCESS_EXPIRES=15m`, `REFRESH_TOKEN_DAYS=30` | defaults in compose | session lifetimes |

Frontend has **no runtime env** — it is a static build using same-origin relative API paths
(`/api`, `/socket.io`). Correct: nothing secret in the SPA.

## 0.6 Persistent data

| Volume | Content | Durability |
|---|---|---|
| `postgres_data` | PGDATA (all tables incl. refresh-token hashes, action tokens, games, ELO) | must back up (`scripts/backup-postgres.sh` → custom-format dump) |
| `uploads_data` | `/app/uploads/avatars/*.webp` (random names, mode 0750 dirs) | must back up alongside DB |
| host `./certs/` | `fullchain.pem` + `privkey.pem` (Let's Encrypt) | never commit; renew via `renew-https.sh` |
| `certbot_webroot` | ACME challenge dir | ephemeral-ish |

**Stateless**: frontend (static), backend process *except* in-memory Socket.io rooms (this is
the scaling constraint). **Stateful**: Postgres, uploads volume.

## 0.7 APIs, auth, background work

- REST: `/api/auth/*` (register/verify/resend/login/refresh/logout/forgot/reset/profile/avatar),
  `/api/game/*`, `/api/leaderboard/*`, `/api/friends/*`, `/api/tournaments/*`.
- Realtime: Socket.io events `create_room/join_room/make_move/game_over/resign/request_rematch/
  accept_rematch/send_message/leave_room/disconnect` → `room_created/game_start/move_made/
  game_ended/rematch_requested/chat_message/opponent_disconnected`.
- Auth: **HttpOnly cookies** (Secure + SameSite=Strict in prod), access JWT carries DB-backed
  session version; refresh tokens opaque + hash-stored + rotated + family-revoked on reuse.
- Authorization: per-route `authMiddleware`; game actions check room membership + turn color;
  uploads require auth.
- Background workers/queues/cron: **none**. Rate limiting is in-process (`express-rate-limit`).
- External services: **SMTP only**.

## 0.8 Tests

- Backend unit (`jest.unit.config.js`), Postgres integration + concurrency
  (`jest.integration.config.js`, requires DB name `*_test`), SMTP integration (smtp-server).
- Frontend: RTL/Jest (`App.session.test.js`, `client.test.js`, component tests).
- E2E: Playwright over real HTTPS through Nginx + two Socket.io browser clients + Mailpit.
- Runner: `scripts/run-e2e.sh` (builds `browser-e2e` profile, self-signed 2-day certs in `tests/certs/`).

## 0.9 Current DevOps inventory (existence, not quality — verdicts in Phase 1)

| Artifact | Path | Status |
|---|---|---|
| Backend Dockerfile | `Chess-Backend/Dockerfile` | good foundation (multi-stage, non-root, healthcheck) |
| Frontend Dockerfile | `Chess-Frontend/Dockerfile` | good foundation (builder + unprivileged nginx) |
| Migration Dockerfile | `Database/migrations/Dockerfile` | single-stage; works, hardenable |
| Prod compose | `docker-compose.yml` | strong: networks, healthchecks, caps drop, ro-fs, logging limits |
| E2E override | `docker-compose.test.yml` | correct isolation (profiles, mailpit, test certs) |
| Nginx | `Chess-Frontend/nginx.conf` | strong TLS/proxy/security-headers config |
| K8s manifests | `Manifest-file/*.yml` | **stale**: placeholder images, `replicas: 2` backend (breaks rooms), HTTP origins, old probes, no PDB/HPA-v2-metric-server guard, postgres StatefulSet diverges from migrations |
| EKS Terraform | `EKS-TF/` | **stale**: flat files, reuses Jenkins VPC/SG, public-only nodes, no private subnets/NAT/IRSA/ESO, tfvars with defaults, S3+Dynamo backend hardcoded |
| Jenkins Server TF | `Jenkins-Server-TF/` | **stale**: `t3.2xlarge` always-on, SG wide-open 8080/9000, single AZ |
| Jenkinsfiles | `Jenkins-Pipeline-Code/` | partial: Sonar/OWASP/Trivy/Slack stages but placeholder URLs, `YOUR_*` vars, long-lived creds |
| GitHub Actions | `.github/workflows/*.yml` | CI exists but non-gating (`exit-code: 0`, `no-fail: true`, `|| true`), no tests/build, triggers Jenkins via long-lived token |
| Monitoring | `monitoring/` | values with **hardcoded Grafana password**, ServiceMonitor points at wrong labels/path |
| Makefile | `Makefile` | legacy EKS/ArgoCD targets, Arabic echo, references missing scripts |
| ArgoCD / Helm / ECR / OIDC / Kyverno / Loki / OTEL / Ansible | — | **do not exist** |

## 0.10 Current deployment model (actual, supported)

Single Linux host → Docker Compose v2 → `docker compose up -d --build`.
TLS via Let's Encrypt (`provision-https.sh`), renewal via cron/systemd (`renew-https.sh`).
K8s/AWS/Terraform/Redis/Jenkins/ArgoCD/monitoring are **explicitly out of phase** per README —
the legacy files are remnants of an older Tetris-project scaffold, not the current contract.

## 0.11 Gaps (facts only; prioritization in roadmap)

1. No CI gating: lint/scan/test failures do not block merge.
2. No image registry flow (no ECR, no immutable tags, no retention, no signing).
3. No K8s path that respects the 1-replica Socket.io constraint.
4. No GitOps (no ArgoCD, no environment promotion model).
5. No centralized observability (logs = json-file rotation; metrics = none; tracing = none).
6. No secrets manager (`.env` file mode 600 — acceptable for single host, not for teams/clusters).
7. Backups are local-only; no off-host encryption/retention/restore schedule.
8. Legacy AWS design is single-AZ public-only with over-permissive SGs.

## Amendment A — Architecture Gate (2026-09-22)

- **A1 (new finding):** `Chess-Backend/src/socket/socketAuth.js` is dead code — the live socket
  path uses `gameSocket.js: socketAuthentication` (cookie + DB session check). The dead file
  falls back to `JWT_SECRET || "chess-secret-key"`, a value `config/security.js` forbids.
  Disposition: delete in the first Wave-0 hygiene PR (behavior-neutral). See gate §1 intro and R-11.
- Ordering authority is now `docs/05-architecture-gate.md` §7 (waves) + `docs/adr/`; the phase
  list in `docs/04` remains the work-breakdown detail but follows gate wave sequencing.

## Amendment B — Wave 0 executed (2026-09-22)

- Deleted dead `Chess-Backend/src/socket/socketAuth.js` (R-11 closed; proof in
  `docs/security/wave0-baseline.md` §2). No behavior change: backend 17/17 + frontend 16/16
  tests green, frontend build green.
- Added: `.github/CODEOWNERS`, `.github/dependabot.yml`, `.github/pull_request_template.md`,
  `.gitleaks.toml` (+ custom placeholder-secret rule), `.pre-commit-config.yaml`,
  `docs/security/wave0-baseline.md`.
- `.gitignore`: `.env.*` blanket (was: 4 variants only), `coverage/`+`*.lcov` for new files,
  `!docs/security/` negations. Verified via `git check-ignore` matrix.
- Secret sweep: no live credentials (6 findings classified: 1 FP, 3 fixtures, 2 non-secret;
  `ChangeMe123!` placeholder tracked, rule-guarded, replaced in Wave 6).
- Residual: branch protection + secret-scanning toggles need owner action (sandbox 403);
  workflows still lack `permissions:` (Wave 2 owns the rewrite — blanket change would break SARIF).
- Test side-effect handled: `npm test` rewrote tracked `coverage/` files; restored to HEAD.

## Amendment C — Wave 1 migration-count correction (2026-09-22)

- The migration chain is **8 files**, not 7: `006_add_game_board_fen.sql` and
  `006_security_integrity.sql` both match the runner pattern and apply in that lexical order.
  Any migrated database therefore holds 8 `schema_migrations` rows.
- Backend startup asserts 7 *named* files (excludes the fen file) — passes regardless; readiness
  needs the `007` row, which implies the full sequential chain. Safe; strengthening the assert
  to 8 names is deferred as an app change (see `docs/security/wave1-baseline.md` §2.5).
- Fixed in Wave 1: integration-test expectation (now 8 names), restore-script count (derived
  from disk, was hardcoded 7 and always failed), README file list/counts.
- Filenames frozen by policy; **no rename** (gate §13 decision documented in wave1-baseline §2).
