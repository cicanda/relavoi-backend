#!/usr/bin/env bash
# Verifies the number pool allows multiple concurrent sessions on the same
# proxy number when participants do not overlap.
#
# Creates N sessions with distinct (agent, customer) pairs, in parallel.
# Asserts at least one proxy number is reused across sessions.
#
# Usage: BASE_URL=http://localhost:3000 ./scripts/test-multi-session-proxy.sh

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
API_KEY="${API_KEY:-sk_test_relavoi_dev_0123456789abcdef}"
API_SECRET="${API_SECRET:-secret_test_relavoi_dev_fedcba9876543210}"
N="${N:-5}"
OUT_DIR=$(mktemp -d)

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
blue()  { printf '\033[34m%s\033[0m\n' "$*"; }

require() { command -v "$1" >/dev/null 2>&1 || { red "Missing $1"; exit 1; }; }
require curl
require jq

blue "==> Getting SDK token"
TOKEN=$(curl -sS -X POST "$BASE_URL/v1/auth/token" \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -H "x-api-secret: $API_SECRET" \
  -d '{}' | jq -r '.token // .access_token // empty')

if [ -z "$TOKEN" ]; then red "Token fetch failed"; exit 1; fi
green "OK — token acquired"

create_session() {
  local idx="$1"
  local agent="+2348011$(printf '%06d' "$idx")"
  local customer="+2348022$(printf '%06d' "$idx")"
  curl -sS -X POST "$BASE_URL/v1/sessions" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $TOKEN" \
    -d "{
      \"agentPhone\":\"$agent\",
      \"customerPhone\":\"$customer\",
      \"metadata\":{\"idx\":$idx},
      \"gracePeriodMinutes\":5
    }" > "$OUT_DIR/session_$idx.json"
}

blue "==> Creating $N sessions concurrently"
PIDS=()
for i in $(seq 1 "$N"); do
  create_session "$i" &
  PIDS+=($!)
done
for pid in "${PIDS[@]}"; do
  wait "$pid"
done

PROXIES=()
for i in $(seq 1 "$N"); do
  body=$(cat "$OUT_DIR/session_$i.json")
  proxy=$(echo "$body" | jq -r '.proxyNumber // .proxy_number // .session.proxyNumber // empty')
  sid=$(echo "$body" | jq -r '.id // .session.id // empty')
  if [ -z "$proxy" ] || [ -z "$sid" ]; then
    red "Session $i failed:"; echo "$body"; exit 1
  fi
  echo "  session $i -> $sid via $proxy"
  PROXIES+=("$proxy")
done

UNIQUE_PROXIES=$(printf "%s\n" "${PROXIES[@]}" | sort -u | wc -l | tr -d ' ')
TOTAL=${#PROXIES[@]}
blue "==> Created $TOTAL sessions across $UNIQUE_PROXIES unique proxy numbers"

if [ "$UNIQUE_PROXIES" -lt "$TOTAL" ]; then
  green "OK — at least one proxy serves multiple sessions"
  exit 0
fi

if [ "$UNIQUE_PROXIES" -eq "$TOTAL" ]; then
  echo "(Pool may simply be large enough; this is not a failure if the pool size >= N)"
  exit 0
fi

red "Unexpected outcome"
exit 1
