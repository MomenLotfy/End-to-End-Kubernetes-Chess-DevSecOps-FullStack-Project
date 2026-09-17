#!/usr/bin/env bash
set -euo pipefail
backup=${1:?Usage: scripts/restore-postgres.sh backups/chess-TIMESTAMP.dump}
target=${RESTORE_DB_NAME:-chess_restore_verify}
[[ -f "$backup" ]] || { echo "Backup not found: $backup" >&2; exit 1; }
[[ "$target" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]] || { echo "Invalid RESTORE_DB_NAME" >&2; exit 1; }
if [[ -f "${backup}.sha256" ]]; then sha256sum --check "${backup}.sha256"; fi

docker compose exec -T chess-postgres sh -c \
  'PGPASSWORD="$POSTGRES_PASSWORD" dropdb --if-exists --force --username="$POSTGRES_USER" "$1" && PGPASSWORD="$POSTGRES_PASSWORD" createdb --username="$POSTGRES_USER" "$1"' sh "$target"
docker compose exec -T chess-postgres sh -c \
  'PGPASSWORD="$POSTGRES_PASSWORD" pg_restore --exit-on-error --no-owner --no-acl --username="$POSTGRES_USER" --dbname="$1"' sh "$target" < "$backup"
count=$(docker compose exec -T chess-postgres sh -c \
  'PGPASSWORD="$POSTGRES_PASSWORD" psql --no-psqlrc --tuples-only --no-align --username="$POSTGRES_USER" --dbname="$1" -c "SELECT count(*) FROM schema_migrations"' sh "$target")
[[ "$count" = "7" ]] || { echo "Restore verification failed: expected 7 migrations, got $count" >&2; exit 1; }
echo "Restore verified in database: $target"
