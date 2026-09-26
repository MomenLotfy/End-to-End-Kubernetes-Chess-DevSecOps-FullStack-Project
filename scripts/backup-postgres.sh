#!/usr/bin/env bash
# Wave 1: encrypted, checksummed, pruned PostgreSQL backups with optional off-host copy.
#
# Required:
#   BACKUP_PASSPHRASE_FILE  path to a file containing the backup passphrase (mode 400/600,
#                           stored OUTSIDE the repo, e.g. ~/.chess-backup-passphrase).
# Optional:
#   BACKUP_DIR        local backup directory (default: ./backups)
#   BACKUP_KEEP_DAYS  prune local backups older than N days (default: 14, 0 disables)
#   BACKUP_OFFHOST_DIR  mounted off-host location (USB/NFS/remote fs) receiving a second
#                       copy; when unset, the script warns and keeps the local copy only.
#
# Failures are fatal (non-zero exit + stderr message) so cron/systemd surfaces them.
# Schedule suggestion (prod host, deploy user):
#   0 3 * * * BACKUP_PASSPHRASE_FILE=$HOME/.chess-backup-passphrase BACKUP_OFFHOST_DIR=/mnt/offhost/chess /opt/chess/scripts/backup-postgres.sh
set -euo pipefail

passfile=${BACKUP_PASSPHRASE_FILE:?Set BACKUP_PASSPHRASE_FILE to a 400/600 passphrase file (see README + docs/security/wave1-baseline.md)}
[[ -f "$passfile" ]] || { echo "Passphrase file not found: $passfile" >&2; exit 1; }
mode=$(stat -c %a "$passfile" 2>/dev/null || stat -f %Lp "$passfile" 2>/dev/null || echo unknown)
case "$mode" in
  400|600) : ;;
  unknown) echo "WARNING: cannot verify passphrase file permissions; continuing" >&2 ;;
  *) echo "Refusing group/world-readable passphrase file (mode $mode on $passfile)" >&2; exit 1 ;;
esac

backup_dir=${BACKUP_DIR:-backups}
keep_days=${BACKUP_KEEP_DAYS:-14}
offhost_dir=${BACKUP_OFFHOST_DIR:-}
mkdir -p "$backup_dir"

stamp=$(date -u +%Y%m%dT%H%M%SZ)
tmp_plain="${backup_dir}/.chess-${stamp}.dump.tmp"
tmp_enc="${backup_dir}/.chess-${stamp}.dump.enc.tmp"
output="${backup_dir}/chess-${stamp}.dump.enc"
cleanup() { rm -f "$tmp_plain" "$tmp_enc"; }
trap cleanup EXIT

docker compose exec -T chess-postgres sh -c \
  'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump --format=custom --no-owner --no-acl --username="$POSTGRES_USER" "$POSTGRES_DB"' > "$tmp_plain"
[[ -s "$tmp_plain" ]] || { echo "Backup is empty" >&2; exit 1; }
# Verify the catalog BEFORE encryption (a corrupt dump must fail here, loudly).
docker compose exec -T chess-postgres pg_restore --list < "$tmp_plain" >/dev/null

openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt \
  -in "$tmp_plain" -out "$tmp_enc" -pass "file:${passfile}"
[[ -s "$tmp_enc" ]] || { echo "Encryption produced empty output" >&2; exit 1; }
chmod 0600 "$tmp_enc"
mv "$tmp_enc" "$output"
(cd "$backup_dir" && sha256sum "$(basename "$output")" > "${output##*/}.sha256")
chmod 0600 "${output}.sha256"
trap - EXIT
cleanup

if [[ -n "$offhost_dir" ]]; then
  mkdir -p "$offhost_dir"
  cp -p "$output" "${output}.sha256" "$offhost_dir/"
  (cd "$offhost_dir" && sha256sum --check "${output##*/}.sha256") \
    || { echo "Off-host copy verification FAILED for $output" >&2; exit 1; }
  echo "Off-host copy verified: ${offhost_dir}/$(basename "$output")" >&2
else
  echo "WARNING: BACKUP_OFFHOST_DIR is not set; backup exists only on this host" >&2
fi

if [[ "$keep_days" != "0" ]]; then
  find "$backup_dir" -maxdepth 1 -name 'chess-*.dump.enc' -mtime "+$keep_days" -delete
  find "$backup_dir" -maxdepth 1 -name 'chess-*.dump.enc.sha256' -mtime "+$keep_days" -delete
fi

echo "$output"
