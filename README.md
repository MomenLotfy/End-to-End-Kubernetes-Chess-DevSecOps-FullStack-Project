# Chess — single-server production stack

This phase runs one production-oriented full-stack instance:

```text
HTTPS / WSS
    ↓
unprivileged Nginx (React static assets + reverse proxy)
    ↓
Node.js 22 / Express / Socket.io (exactly one backend instance)
    ↓
PostgreSQL 16 + persistent uploads volume + external SMTP
```

Kubernetes, AWS, Terraform, Redis, Jenkins, Argo CD and monitoring infrastructure are deliberately outside this phase.

## Production requirements

- Linux server with public ports 80 and 443
- Docker Engine with Docker Compose v2
- Public DNS record pointing to the server
- SMTP submission account supporting TLS
- `openssl` and `sudo` for certificate preparation

Create configuration without committing it:

```bash
cp .env.example .env
openssl rand -base64 48   # use for JWT_SECRET
openssl rand -base64 32   # use for DB_PASSWORD
chmod 600 .env
```

`APP_ORIGIN` must be the exact public HTTPS origin, with no trailing slash. Production startup rejects HTTP origins, weak JWT configuration, and missing DB/SMTP settings.

## HTTPS and startup

Issue the first Let's Encrypt certificate while port 80 is available:

```bash
export DOMAIN=chess.example.com
export LETSENCRYPT_EMAIL=admin@example.com
scripts/provision-https.sh
```

Then start the complete stack:

```bash
docker compose up -d --build
docker compose ps
docker compose logs chess-migration
docker compose exec chess-frontend nginx -t
curl -I http://chess.example.com/                 # 308 to HTTPS
curl --fail https://chess.example.com/liveness
curl --fail https://chess.example.com/readiness
```

Nginx terminates TLS, redirects HTTP to HTTPS, adds HSTS only on HTTPS, proxies `/api`, authenticated `/uploads`, and `/socket.io`, and serves the React build and same-origin Stockfish WebAssembly assets. Cookies are `Secure`, `HttpOnly`, and `SameSite=Strict` in production.

Renew certificates from cron/systemd after testing the command manually:

```bash
DOMAIN=chess.example.com scripts/renew-https.sh
```

## Services and persistence

- `chess-postgres`: PostgreSQL 16 on the private Compose network; no host DB port.
- `chess-migration`: one-shot, checksummed, advisory-locked migrations.
- `chess-backend`: one non-root instance only.
- `chess-frontend`: unprivileged Nginx on container ports 8080/8443.
- `postgres_data`: durable PostgreSQL data.
- `uploads_data`: durable normalized WebP avatars.

Do not run `docker compose up --scale chess-backend=2`. Socket membership, room queues and rematch state remain process-local. Redis/multi-replica work is deferred.

## Migrations

The migration container executes every ordered migration in a transaction:

```text
001_init.sql
002_game_features.sql
003_achievements.sql
004_friends.sql
005_tournaments.sql
006_add_game_board_fen.sql
006_security_integrity.sql
007_fullstack_hardening.sql
```

It holds a PostgreSQL advisory lock, stores SHA-256 checksums, and refuses a changed migration that was already applied. The runner applies all eight files in lexical order; backend startup additionally requires the seven named migrations with checksums, and readiness requires migration 007. Existing migration filenames are frozen (see docs/security/wave1-baseline.md); new migrations continue at 008+.

Run real PostgreSQL integration/concurrency tests in an isolated `chess_test` database:

```bash
docker compose --profile test run --rm postgres-integration-tests
```

The integration suite requires the database name to end in `_test` and covers schema objects, concurrent/duplicate moves, atomic game/ELO/score settlement, tournament capacity races, and refresh-token reuse detection.

## Authentication and security

- Browser credentials are HttpOnly cookies; no token is stored in localStorage or sessionStorage.
- Access tokens contain a database-backed session version.
- Password reset increments that version and revokes all refresh tokens.
- Logout invalidates all sessions for that account.
- Refresh tokens are opaque, hash-stored, rotated, and family-revoked on reuse.
- Email verification and password-reset tokens are random, hash-stored, expiring and single-use.
- Unsafe API requests require an allowed `Origin`; cross-site and originless production requests are rejected.
- Login, registration, email generation, reset and refresh have separate rate limits.
- SMTP port 587 requires STARTTLS by default; certificate verification is enabled.
- Client-submitted results, scores, ELO and achievements are rejected. Multiplayer finalization writes them atomically from authoritative server state.

## Avatar uploads

Uploads are limited to 2 MB. The backend ignores filename and MIME claims, validates the complete PNG/JPEG/GIF/WebP container, decodes pixels with Sharp, rejects SVG/malformed/polyglot/animated content, strips metadata, resizes, and stores a random WebP filename with restrictive permissions. Replacing an avatar cleans up the previous managed file.

## Tests

Local source tests:

```bash
(cd Chess-Backend && npm ci && npm test -- --runInBand)
(cd Chess-Frontend && npm ci && npm test -- --watchAll=false)
(cd Chess-Frontend && npm run build)
(cd Chess-Backend && npm audit)
(cd Chess-Frontend && npm audit)
```

Real HTTPS/browser/SMTP/two-client E2E uses a two-day self-signed test certificate and Mailpit only in the test override:

```bash
scripts/run-e2e.sh
```

The browser suite reaches the system through Nginx and covers registration, verification email, login, session restoration, reset/invalidation, logout, CSRF/origin failures, client-result rejection, avatar replacement/rejection, two browser Socket.io clients, illegal and duplicate moves, synchronization, reconnect, refresh during play, checkmate, ELO and rematch.

Self-signed test certificates and Mailpit are not production configuration.

## Backup and restore verification

Create a PostgreSQL custom-format backup and verify its catalog:

```bash
# One-time setup: create the backup passphrase OUTSIDE the repo (mode 0600)
openssl rand -base64 32 > ~/.chess-backup-passphrase && chmod 600 ~/.chess-backup-passphrase
export BACKUP_PASSPHRASE_FILE=~/.chess-backup-passphrase
scripts/backup-postgres.sh
```

Backups are AES-256-CBC encrypted (`openssl enc -pbkdf2`), checksummed, and pruned after
`BACKUP_KEEP_DAYS` (default 14). Set `BACKUP_OFFHOST_DIR` to a mounted off-host location
(USB/NFS/remote filesystem) for an automatic second copy; see docs/security/wave1-baseline.md.

Restore without touching the live database; the default target is `chess_restore_verify`:

```bash
scripts/restore-postgres.sh backups/chess-YYYYMMDDTHHMMSSZ.dump.enc
```

The restore command verifies the checksum, recreates the verification database, uses
`pg_restore --exit-on-error`, and confirms the migration-record count matches the migration
files on disk. Legacy unencrypted `.dump` files remain readable by the restore script.

## Graceful operation

- `/liveness` reports process liveness.
- `/readiness` requires startup completion, PostgreSQL access and migration 007.
- SIGTERM/SIGINT stop readiness, close Socket.io and HTTP, then close PostgreSQL.
- Normal shutdown and transient disconnects do not mark games abandoned. A player explicitly leaving a game concedes it; disconnected players may rejoin persisted rooms.

## Known limitation

The backend must remain at exactly one instance until a separately approved Redis/shared-state phase. This is the intentional production limit of the current single-server architecture.
