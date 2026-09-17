#!/usr/bin/env bash
set -euo pipefail
mkdir -p backups
stamp=$(date -u +%Y%m%dT%H%M%SZ)
output="backups/chess-${stamp}.dump"
tmp="${output}.tmp"

docker compose exec -T chess-postgres sh -c \
  'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump --format=custom --no-owner --no-acl --username="$POSTGRES_USER" "$POSTGRES_DB"' > "$tmp"
[[ -s "$tmp" ]] || { rm -f "$tmp"; echo "Backup is empty" >&2; exit 1; }
pg_restore_cmd=(docker compose exec -T chess-postgres pg_restore --list)
"${pg_restore_cmd[@]}" < "$tmp" >/dev/null
chmod 0600 "$tmp"
mv "$tmp" "$output"
sha256sum "$output" > "${output}.sha256"
echo "$output"
