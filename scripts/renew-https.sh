#!/usr/bin/env bash
set -euo pipefail
: "${DOMAIN:?Set DOMAIN to the public DNS name}"
[[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || { echo "Invalid DOMAIN" >&2; exit 1; }

was_running=false
if docker compose ps --status running 2>/dev/null | grep -q chess-frontend; then
  was_running=true
  docker compose stop chess-frontend
fi
restart_frontend() {
  if [[ "$was_running" == true ]]; then docker compose up -d chess-frontend; fi
}
trap restart_frontend EXIT

docker run --rm --name chess-certbot-renew \
  -p 80:80 \
  -v "$PWD/letsencrypt:/etc/letsencrypt" \
  certbot/certbot:v2.11.0 renew --non-interactive
sudo install -o 101 -g 101 -m 0644 "letsencrypt/live/$DOMAIN/fullchain.pem" certs/fullchain.pem
sudo install -o 101 -g 101 -m 0600 "letsencrypt/live/$DOMAIN/privkey.pem" certs/privkey.pem
openssl x509 -in certs/fullchain.pem -noout -dates
openssl pkey -in certs/privkey.pem -check -noout
restart_frontend
was_running=false
trap - EXIT
if docker compose ps --status running 2>/dev/null | grep -q chess-frontend; then
  docker compose exec chess-frontend nginx -t
fi
