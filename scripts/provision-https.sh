#!/usr/bin/env bash
set -euo pipefail

: "${DOMAIN:?Set DOMAIN to the public DNS name}"
: "${LETSENCRYPT_EMAIL:?Set LETSENCRYPT_EMAIL}"
[[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || { echo "Invalid DOMAIN" >&2; exit 1; }
[[ "$LETSENCRYPT_EMAIL" == *@* ]] || { echo "Invalid LETSENCRYPT_EMAIL" >&2; exit 1; }

mkdir -p letsencrypt certs
if docker compose ps --status running 2>/dev/null | grep -q chess-frontend; then
  echo "Stop the frontend before standalone certificate issuance: docker compose stop chess-frontend" >&2
  exit 1
fi

docker run --rm --name chess-certbot \
  -p 80:80 \
  -v "$PWD/letsencrypt:/etc/letsencrypt" \
  certbot/certbot:v2.11.0 certonly --standalone \
  --non-interactive --agree-tos --no-eff-email \
  --email "$LETSENCRYPT_EMAIL" -d "$DOMAIN"

sudo install -o 101 -g 101 -m 0644 "letsencrypt/live/$DOMAIN/fullchain.pem" certs/fullchain.pem
sudo install -o 101 -g 101 -m 0600 "letsencrypt/live/$DOMAIN/privkey.pem" certs/privkey.pem
openssl x509 -in certs/fullchain.pem -noout -subject -issuer -dates
openssl pkey -in certs/privkey.pem -check -noout

echo "Certificate prepared. Set APP_ORIGIN=https://$DOMAIN and run docker compose up -d --build."
