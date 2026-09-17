#!/usr/bin/env bash
set -euo pipefail
mkdir -p tests/certs
if [[ ! -s tests/certs/fullchain.pem || ! -s tests/certs/privkey.pem ]]; then
  openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days 2 \
    -subj "/CN=chess-frontend" \
    -addext "subjectAltName=DNS:chess-frontend,DNS:localhost" \
    -keyout tests/certs/privkey.pem -out tests/certs/fullchain.pem
  chmod 0644 tests/certs/fullchain.pem tests/certs/privkey.pem
fi

docker compose -f docker-compose.yml -f docker-compose.test.yml --profile e2e up -d --build \
  chess-postgres chess-migration mailpit chess-backend chess-frontend
docker compose -f docker-compose.yml -f docker-compose.test.yml --profile e2e run --rm browser-e2e
