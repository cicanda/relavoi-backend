#!/usr/bin/env bash
# Run migrations inside the api container of the full docker compose stack.
#
# Usage:
#   ./scripts/docker-migrate.sh

set -euo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-docker/docker-compose.full.yml}"
SERVICE="${SERVICE:-api}"

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
blue()  { printf '\033[34m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }

if ! command -v docker >/dev/null 2>&1; then
  red "docker is not installed"; exit 1
fi

blue "==> Running migrations in $SERVICE container ($COMPOSE_FILE)"
docker compose -f "$COMPOSE_FILE" exec "$SERVICE" node dist/scripts/run-migrations.js

green "OK — migrations applied"
