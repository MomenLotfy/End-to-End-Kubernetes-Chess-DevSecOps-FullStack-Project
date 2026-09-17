# Full-stack security operations

## Supported deployment

The supported deployment in this phase is one HTTPS single-server Docker Compose stack with exactly one backend instance. Multi-replica Socket.io, Redis, Kubernetes and cloud infrastructure are deferred.

## Secrets and transport

- Keep `.env`, `certs/`, `letsencrypt/`, backups and SMTP credentials outside Git.
- Use a unique random `JWT_SECRET` of at least 32 characters.
- Use `scripts/provision-https.sh` for the initial Let's Encrypt certificate and test renewal regularly.
- `APP_ORIGIN` must be the exact public HTTPS origin.
- SMTP uses TLS 1.2 or newer and requires STARTTLS on submission ports by default.
- Set `DB_SSL=true` and provide `DB_SSL_CA` when PostgreSQL is outside the private single-host Compose network.

## Account/session controls

Access and refresh credentials are HttpOnly cookies. Production cookies are Secure and SameSite=Strict. Access JWTs carry a database-backed session version. Password reset and logout invalidate sessions and revoke refresh tokens. Refresh tokens and account-action tokens are hash-stored, expiring and single-use; reuse revokes the refresh family.

All unsafe browser API requests require an allowed Origin. CORS does not replace this request-origin control. Authentication and account-email routes have independent rate limits.

Never log cookies, passwords, SMTP credentials, verification links or reset links.

## Game integrity

The backend validates moves with chess.js under a PostgreSQL game-row lock. Game completion, ELO, authoritative scores and base achievements are committed in one transaction and guarded by the game status transition. The client score submission endpoint is deliberately rejected.

Network disconnects preserve games for reconnect. Explicit leave/resign settles the game. Do not scale the backend above one instance in this phase.

## Uploads

Avatar uploads are capped at 2 MB, fully container-checked, decoded and re-encoded with Sharp, stripped of metadata, resized, and stored as random WebP names. SVG, malformed, trailing/polyglot and animated inputs are rejected. Uploads live on the persistent `uploads_data` volume and require authentication to retrieve.

## Vulnerability reporting

Do not include credentials, private user data or usable exploit payloads in a public issue. Report privately to the repository owner with affected version, reproduction conditions and impact. Rotate potentially exposed credentials before sharing logs.
