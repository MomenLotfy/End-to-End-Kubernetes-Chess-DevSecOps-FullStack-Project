# Phase 1 — Reverse Engineering Report

## 1. Application architecture

### Frontend (`Chess-Frontend/`, React 18 + react-scripts 5)

- SPA composition in `App.js`: `home | local | online | ai` screens + `/verify-email`,
  `/reset-password`, `/meet-the-creator` routes. State: `useChessGame` (local rules via
  `engine/chessEngine.js`), `useMultiplayer` (Socket.io client), `useGameTimer`, `useStockfish`
  (WASM worker, same-origin `/stockfish/`).
- API layer `api/client.js` uses **same-origin relative URLs** (`/api/*`, `/socket.io/*`) with
  `credentials: include` — no tokens in localStorage/sessionStorage (only non-secret user
  display data). Session restore on boot via `POST /api/auth/refresh`.
- Auth UI: `AuthModal`, `AccountAction` (verify + reset), `ProfileModal` (incl. avatar upload),
  `LeaderboardModal`, `FriendsModal`, `TournamentsModal`, `ReplayModal`, `ChatPanel`.
- Build: `npm run build` → static `/usr/share/nginx/html`, hashed `/static/*` assets cached
  immutable for 1y; Stockfish served with `COEP: require-corp`.

### Backend (`Chess-Backend/`, Node 22 / Express 4 / Socket.io 4)

- `server.js` boot order: `validateEnvironment()` → express app → trust proxy (1 hop) → helmet
  (CSP same-self) → CORS allowlist → cookie parser → `32kb` JSON limit → morgan→winston →
  global `/api` rate limit (100/15m) → `originProtection` → per-route auth/email rate limits →
  `/uploads` (auth + static, no index) → 5 routers → `/liveness`+`/readiness` → 404 → error
  handler → `initSocket(io)` → `connectWithRetry` (exp backoff ×5) → `assertMigrationsComplete`
  (7 files + checksums) → `rebuildActiveRooms()` → `listen(5000)` → `startupReady=true`.
- Auth model: access JWT (15m, HttpOnly cookie, carries `sessionVersion`) + opaque refresh
  token (hash-stored, rotated, family revoke on reuse). `POST /api/auth/save` deliberately
  returns 403 — scores/ELO/achievements are server-computed.
- Socket model: in-memory `rooms` map (`{id, chess, board, turn, players, status, gameId}`).
  Moves: membership + turn check → `chess.js` validation under **Postgres row lock** →
  persist move → broadcast `move_made` → on game over, finalize in one tx
  (game status + ELO + scores + achievements) → broadcast `game_ended`.
  Disconnect = transient (rejoin allowed); explicit `leave_room`/resign concedes.
- SMTP: `services/mail.js` via nodemailer; STARTTLS enforced on :587 by default, cert verify on.
- Shutdown: SIGTERM/SIGINT → `shuttingDown=true`, stop readiness → close Socket.io → close
  HTTP → `drainRoomOperations()` → `pool.end()` → exit. Uncaught exceptions trigger same path
  with exit 1. Correct.

### Database (PostgreSQL 16)

Migrations (ordered, transactional, advisory-locked, checksummed by `run.js`):

| File | Content |
|---|---|
| `001_init.sql` | users, scores (+indexes) |
| `002_game_features.sql` | games, moves |
| `003_achievements.sql` | achievements catalog + user achievements |
| `004_friends.sql` | friendships |
| `005_tournaments.sql` | tournaments, participants, matches |
| `006_security_integrity.sql` | constraints/indexes for integrity |
| `006_add_game_board_fen.sql` | **filename collision with above** — runner sorts lexically; both run, but naming must be fixed (rename to `006b_…` or merge) |
| `007_fullstack_hardening.sql` | final hardening objects; backend readiness requires this row + checksum |

Pool: max 10, idle 30s, connect timeout 5s, statement timeout 10s, `application_name=chess-backend`.

### Cache / queues / workers / storage

None. No Redis, no queue, no cron inside the app. Avatar files on `uploads_data` volume.
External dependency: SMTP submission server only.

## 2. Runtime architecture

- **What runs, where**: 4 compose services on one host, all on private bridge `chess_internal`.
- **Start order** (enforced by `depends_on` conditions): `chess-postgres` (healthy) →
  `chess-migration` (completed) → `chess-backend` (healthy) → `chess-frontend` (healthy).
- **Health**: backend `/liveness` (process) and `/readiness` (ready flag + `007` checksum row);
  compose healthchecks poll them; Nginx exposes them publicly (by design, no sensitive data).
- **Probes**: readiness fails closed during boot/shutdown/DB outage — correct for rolling updates.
- **Single-replica invariant**: `Socket.io` rooms + rate-limit counters are in-process. Scaling
  past 1 backend breaks matchmaking, rematch, and per-IP limits. Any K8s/HPA design must use
  `replicas: 1` + `Recreate` (or solve with Redis adapter + sticky sessions — deferred phase).
- **Nginx role**: TLS termination (1.2+), HTTP→308, `/api` (20r/s per IP, burst 40),
  `/uploads` + `/socket.io` proxy with cookie/upgrade passthrough, static SPA + hashed-cache
  + strict headers (HSTS, CSP `wasm-unsafe-eval` for Stockfish, COOP/COEP, frame deny).
  `client_max_body_size 2m` matches avatar limit. Timeouts sane (5s connect, 30s proxy, 75s WS).

## 3. Current DevOps architecture — file-by-file verdict

### 3.1 KEEP (harden incrementally)

| File | Purpose | Strengths | Weaknesses / risks |
|---|---|---|---|
| `docker-compose.yml` | prod single-server stack | networks, health-gated deps, `no-new-privileges`, cap-drop, ro-fs, tmpfs, log rotation, no DB host port | no resource limits; postgres runs as root (upstream default); missing `init: true` |
| `docker-compose.test.yml` | e2e override | profiles, mailpit, isolated test certs, no prod secret reuse | `ipc: host` for playwright (documented need, keep) |
| `Chess-Backend/Dockerfile` | backend image | multi-stage, pinned lockfile, non-root 1001, healthcheck, no dev deps | no `tini`/init, no image labels/SBOM annotations, `npm cache clean` ok |
| `Chess-Frontend/Dockerfile` | frontend image | builder pattern, unprivileged nginx, USER 101 | `nginx -t` healthcheck only tests config (compose overrides with HTTPS probe — fine) |
| `Chess-Frontend/nginx.conf` | edge proxy | TLS 1.2+, HSTS only on :8443, rate limit, tight proxy timeouts, correct COEP/CSP for WASM | `server_name _` (fine for single-site); no `limit_req` on `/socket.io/` (add later, low risk of breaking); gzip includes `image/svg+xml` (minor) |
| `Database/migrations/*` | schema + runner | advisory lock, checksums, ordered tx, readiness coupling | `006` filename collision; no down-migrations (acceptable — forward-only policy must be documented) |
| `scripts/provision-https.sh`, `renew-https.sh`, `backup-postgres.sh`, `restore-postgres.sh`, `run-e2e.sh` | TLS + backup + e2e ops | small, auditable, verify-on-restore | backups local-only (needs off-host step in roadmap) |
| `.github/workflows/dependency-security.yml` | weekly audit | scheduled SCA signal | Slack-only, no gating, no SBOM — refactor into unified security workflow |

### 3.2 REFACTOR (structure right, content stale)

| File | Verdict | Why | Action |
|---|---|---|---|
| `.github/workflows/chess-backend-ci.yml`, `chess-frontend-ci.yml` | **refactor** | Jobs exist (gitleaks, eslint, trivy fs, hadolint) but **nothing gates**: `exit-code: 0`, `no-fail: true`, `|| true`; no `npm test`, no `npm run build`, no image build/scan; Jenkins trigger uses long-lived `JENKINS_USER/TOKEN` secrets | Rewrite as `ci.yml` (test+build+gating scans) + `security.yml` (scheduled); remove Jenkins trigger or gate it behind CI success + OIDC later |
| `.github/workflows/terraform-validation.yml` | **refactor** | `fmt/validate` + tfsec exist; `continue-on-error: true` on fmt; tfsec deprecated upstream (use Trivy config) | Keep shape, enforce fmt, replace tfsec with `trivy config`, add `tflint`/checkov only for new `terraform/` tree |
| `Database/migrations/Dockerfile` | **refactor** | Works, non-root, but single-stage + no healthcheck/labels | Add labels + `npm ci --omit=dev` already there; add hadolint-clean `apk` hygiene if extended |
| `monitoring/servicemonitor.yaml` | **refactor** | Concept right (ServiceMonitor per app) | Selector `app: chess` matches nothing; path `/health` 308-redirects; port name `http` must match future Service; rewrite when Prometheus ships |
| `scripts/bootstrap.sh`, `install-*.sh`, `cleanup.sh` | **refactor/replace** | Bootstrap does S3+Dynamo correctly (SSE, versioning, public-block) | Tied to legacy flat TF layout; rewrite for `terraform/` modules + envs |

### 3.3 REPLACE (do not build on these)

| File(s) | Why replace, not fix |
|---|---|
| `Manifest-file/deployment-backend.yml` | `replicas: 2` **breaks the app** (split-brain rooms); `FRONTEND_URL=http://…` fails prod validation (HTTPS-only); probes hit `/health` (308, not `/readiness`); image `YOUR_DOCKERHUB_USERNAME/chess-backend:1`; no PDB/resource-policy/startupProbe; Service right (ClusterIP) but env wrong |
| `Manifest-file/deployment-frontend.yml` | `replicas: 2` + `LoadBalancer` per Service (cost + TLS gap: no TLS, port 80); env `REACT_APP_API_URL=http://…` contradicts same-origin design; probes hit `/` (200 even when backend down) |
| `Manifest-file/deployment-postgres.yml` | StatefulSet embeds a **2-table init script** instead of the real 7-migration chain; `storageClassName: gp2`, no backup/restore story; on EKS the answer is RDS, not in-cluster Postgres |
| `Manifest-file/infrastructure.yml` | HPA `minReplicas: 2` on backend violates invariant; NetworkPolicies allow frontend→backend but backend egress blocks SMTP (port 587) and DNS TCP; RBAC Role grants `create/update/patch/delete` on pods/svcs — far too broad for an app SA |
| `EKS-TF/*` | Flat files, reuses Jenkins VPC/SG via tag lookups, **public-only** nodes, no private subnets/NAT, no IRSA/OIDC, no ESO/Secrets Manager, no RDS/ElastiCache, log retention 7d, `variables.tfvars` committed with sizing |
| `Jenkins-Server-TF/*` | Always-on `t3.2xlarge` (~$200+/mo) for a static Jenkins; SG opens 22/8080/9000 to `0.0.0.0/0`; single AZ; user-data installs tools imperatively |
| `Jenkins-Pipeline-Code/*` | Placeholder hosts (`YOUR_JENKINS_IP`, `team@yourcompany.com`), long-lived `aws-key` creds, no OIDC, no image signing, Slack+email spam per stage; keep the *stage list* as requirements input, rewrite pipelines |
| `monitoring/prometheus-values.yaml` | Hardcoded `adminPassword: "ChangeMe123!"`, Grafana `LoadBalancer` (public, no TLS/auth story), 7d retention with no remote-write decision |
| `Makefile` | Targets reference scripts/flows being replaced; rewrite with `lint/test/build/scan/tf-docs` targets |

### 3.4 Missing (gaps, not failures)

Helm chart (or Kustomize base), ECR + image signing (Cosign), GitHub OIDC→AWS, ArgoCD
ApplicationSet, Prometheus/Grafana/Loki/OTel stack, External Secrets Operator, Kyverno policies,
Ansible roles, Linux baseline docs, DR runbook, SLOs/alerts. All are roadmap items — introduced
only when their prerequisite phase lands (no tool sprawl).

## 4. Risk register (top 10, ordered)

1. **K8s manifests would break prod if applied** — backend `replicas: 2` + HTTP origins.
   Mitigation: never apply `Manifest-file/`; build Helm chart with `replicas: 1`, validated env.
2. **CI gates nothing** — vulnerable deps/images can merge silently. Mitigation: new `ci.yml`
   with failing gates for tests, Trivy HIGH/CRITICAL, Hadolint, Gitleaks.
3. **Long-lived Jenkins/AWS credentials** in GitHub secrets. Mitigation: OIDC role assumption;
   delete static keys.
4. **Legacy AWS is public-only / wide-open SGs** (22/8080/9000). Mitigation: new VPC module
   (public/private, NAT, endpoints); Jenkins only if justified, else GitHub Actions + OIDC.
5. **Hardcoded Grafana password + public LB**. Mitigation: Secrets Manager + ClusterIP +
   ingress with TLS.
6. **Backups local-only**. Mitigation: encrypted off-host copy + scheduled restore test (RPO/RTO).
7. **Migration filename collision** (`006_*.sql` × 2). Mitigation: rename + checksum re-baseline
   in a controlled migration PR (runner refuses changed checksums — handle explicitly).
8. **No resource limits in compose** — noisy-neighbor/OOM risk. Mitigation: add `deploy.resources`.
9. **Postgres container runs as root** (default entrypoint needs it for init; data dir is root-owned).
   Mitigation: accept upstream pattern, constrain with cap-drop + no-new-privs + NetworkPolicy later.
10. **Rate limits + rooms are in-process** — any future scale-out needs Redis adapter + sticky
    sessions first. Mitigation: documented invariant + HPA explicitly disabled for backend.

11. **Dead `socketAuth.js` with weak fallback secret** (gate finding A1) — unreachable today, but
    a future import would silently weaken socket auth to `"chess-secret-key"`. Mitigation: delete
    the file in Wave 0 (behavior-neutral); Gitleaks + Semgrep guard against reintroduction.

## Amendment A — Architecture Gate (2026-09-22)

Risks 1–11 stand. Gate `docs/05-architecture-gate.md` converts mitigations into sequenced waves:
R-2/R-3 via Waves 0–3, R-1/R-4/R-5 via Waves 4–5, R-6 via Wave 1 (off-host backup) + Wave 4 (RDS),
R-7 via Wave 1 checksum re-baseline runbook, R-8 via Wave 1 limits, R-9 accepted (upstream pattern),
R-10 via Wave 7 Scale-Out Gate, R-11 via Wave 0 deletion. Decisions frozen in `docs/adr/001–010`.

## Amendment B — Wave 0 executed (2026-09-22): R-11 CLOSED

- `socketAuth.js` deleted after proving unreachability: full `require()` inventory (zero
  importers), no dynamic `require(var)` in `src/`, zero test/config/compose/workflow references,
  live socket path (`gameSocket.js:socketAuthentication`) confirmed and untouched.
- Behavioral safety: backend suite 3/3 (17 tests), frontend suite 8/8 (16 tests), frontend
  production build — all green after deletion. Backend coverage report lists only `gameSocket.js`
  under `src/socket/`, corroborating the file was never loaded.
- `full report.md` claims about this file (and the `middleware/auth.js` fallback) confirmed stale:
  live `auth.js` verifies via `requireJwtSecret()`, which throws on missing/placeholder secrets.
- Remaining Git-security gaps moved to `docs/security/wave0-baseline.md` §7 (R-G1…R-G5).
