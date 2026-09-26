#!/usr/bin/env bash
# Wave 1: restore verification for encrypted (.dump.enc) and legacy plaintext (.dump) backups.
# Never touches the live database: restores into RESTORE_DB_NAME (default chess_restore_verify),
# then confirms the migration-record count matches the migration files on disk.
set -euo pipefail
backup=${1:?Usage: scripts/restore-postgres.sh backups/chess-TIMESTAMP.dump[.enc]}
target=${RESTORE_DB_NAME:-chess_restore_verify}
[[ -f "$backup" ]] || { echo "Backup not found: $backup" >&2; exit 1; }
[[ "$target" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]] || { echo "Invalid RESTORE_DB_NAME" >&2; exit 1; }
if [[ -f "${backup}.sha256" ]]; then (cd "$(dirname "$backup")" && sha256sum --check "$(basename "${backup}.sha256")"); fi

restore_src="$backup"
if [[ "$backup" == *.enc ]]; then
  passfile=${BACKUP_PASSPHRASE_FILE:?Set BACKUP_PASSPHRASE_FILE to decrypt this backup}
  [[ -f "$passfile" ]] || { echo "Passphrase file not found: $passfile" >&2; exit 1; }
  restore_src=$(mktemp)
  trap 'rm -f "$restore_src"' EXIT
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 \
    -in "$backup" -out "$restore_src" -pass "file:${passfile}"
  [[ -s "$restore_src" ]] || { echo "Decryption produced empty output" >&2; exit 1; }
fi

docker compose exec -T chess-postgres sh -c \
  'PGPASSWORD="$POSTGRES_PASSWORD" dropdb --if-exists --force --username="$POSTGRES_USER" "$1" && PGPASSWORD="$POSTGRES_PASSWORD" createdb --username="$POSTGRES_USER" "$1"' sh "$target"
docker compose exec -T chess-postgres sh -c \
  'PGPASSWORD="$POSTGRES_PASSWORD" pg_restore --exit-on-error --no-owner --no-acl --username="$POSTGRES_USER" --dbname="$1"' sh "$target" < "$restore_src"

# Expected count is derived from the migration files, not hardcoded: the previous literal
# "7" was stale the moment the 8th file (006_add_game_board_fen.sql) landed.
expected=$(ls Database/migrations/[0-9][0-9][0-9]_*.sql 2>/dev/null | wc -l)
[[ "$expected" -gt 0 ]] || { echo "No migration files found; run from the repository root" >&2; exit 1; }
count=$(docker compose exec -T chess-postgres sh -c \
  'PGPASSWORD="$POSTGRES_PASSWORD" psql --no-psqlrc --tuples-only --no-align --username="$POSTGRES_USER" --dbname="$1" -c "SELECT count(*) FROM schema_migrations"' sh "$target")
[[ "$count" = "$expected" ]] || { echo "Restore verification failed: expected $expected migrations, got $count" >&2; exit 1; }
echo "Restore verified in database: $target ($count migrations)"
