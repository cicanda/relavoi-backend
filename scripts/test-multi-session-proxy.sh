#!/usr/bin/env bash
# Validates Relavoi's atomic number-pool allocation:
#   • Reduces the available pool to a SINGLE number.
#   • Creates 5 sessions with non-overlapping participants — all must land on
#     that one proxy.
#   • Routes a call from agent1 → assert XML targets customer1.
#   • Routes a call from customer3 → assert XML targets agent3.
#   • Attempts a 6th session that REUSES agent1's phone → must be rejected
#     (participant-overlap on the only proxy → no allocation possible).
#
# This script assumes the dev seed has run (10 proxy numbers seeded). It
# uses docker exec on relavoi-redis to whittle the Redis pool set down to
# a single number for the duration of the test, then restores all numbers
# at the end.
#
# Usage: BASE_URL=http://localhost:3000 ./scripts/test-multi-session-proxy.sh

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
API_KEY="${API_KEY:-sk_test_relavoi_dev_0123456789abcdef}"
API_SECRET="${API_SECRET:-secret_test_relavoi_dev_fedcba9876543210}"
REDIS_PREFIX="${REDIS_PREFIX:-relavoi:}"
REDIS_CONTAINER="${REDIS_CONTAINER:-relavoi-redis}"
POOL_REGION="${POOL_REGION:-lagos}"
POOL_PROVIDER="${POOL_PROVIDER:-AFRICASTALKING}"
N_SESSIONS="${N_SESSIONS:-5}"
KEEP_NUMBER="${KEEP_NUMBER:-+2348000000001}"

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
blue()  { printf '\033[34m%s\033[0m\n' "$*"; }
dim()   { printf '\033[2m%s\033[0m\n' "$*"; }

require() { command -v "$1" >/dev/null 2>&1 || { red "Missing $1"; exit 1; }; }
require curl
require jq
require docker

POOL_KEY_R="${REDIS_PREFIX}pool:${POOL_REGION}:available"
POOL_KEY_RP="${REDIS_PREFIX}pool:${POOL_REGION}:${POOL_PROVIDER}:available"

snapshot_pool() {
  ORIG_POOL_R=$(docker exec "$REDIS_CONTAINER" redis-cli SMEMBERS "$POOL_KEY_R" | tr '\n' ' ')
  ORIG_POOL_RP=$(docker exec "$REDIS_CONTAINER" redis-cli SMEMBERS "$POOL_KEY_RP" | tr '\n' ' ')
}

restore_pool() {
  blue "==> Restoring original pool state"
  docker exec "$REDIS_CONTAINER" redis-cli DEL "$POOL_KEY_R" >/dev/null
  docker exec "$REDIS_CONTAINER" redis-cli DEL "$POOL_KEY_RP" >/dev/null
  if [[ -n "${ORIG_POOL_R:-}" ]]; then
    # shellcheck disable=SC2086
    docker exec "$REDIS_CONTAINER" redis-cli SADD "$POOL_KEY_R" $ORIG_POOL_R >/dev/null
  fi
  if [[ -n "${ORIG_POOL_RP:-}" ]]; then
    # shellcheck disable=SC2086
    docker exec "$REDIS_CONTAINER" redis-cli SADD "$POOL_KEY_RP" $ORIG_POOL_RP >/dev/null
  fi
}

trap restore_pool EXIT

# ─── Step 1: snapshot then reduce pool to 1 number ────────────────────────────
blue "==> Snapshotting pool"
snapshot_pool
dim "  original: $ORIG_POOL_R"

blue "==> Reducing pool to single number: $KEEP_NUMBER"
docker exec "$REDIS_CONTAINER" redis-cli DEL "$POOL_KEY_R" >/dev/null
docker exec "$REDIS_CONTAINER" redis-cli DEL "$POOL_KEY_RP" >/dev/null
docker exec "$REDIS_CONTAINER" redis-cli SADD "$POOL_KEY_R" "$KEEP_NUMBER" >/dev/null
docker exec "$REDIS_CONTAINER" redis-cli SADD "$POOL_KEY_RP" "$KEEP_NUMBER" >/dev/null

# ─── Step 2: get SDK token ────────────────────────────────────────────────────
blue "==> Auth"
TOKEN_RESP=$(curl -sS -X POST "$BASE_URL/v1/auth/token" \
  -H "Content-Type: application/json" \
  -d "{\"apiKey\":\"$API_KEY\",\"apiSecret\":\"$API_SECRET\"}")
TOKEN=$(echo "$TOKEN_RESP" | jq -r '.accessToken')
[[ "$TOKEN" == "null" || -z "$TOKEN" ]] && { red "no accessToken: $TOKEN_RESP"; exit 1; }
green "  ✓ got SDK JWT"
AUTH="Authorization: Bearer $TOKEN"

# ─── Step 3: create N sessions with distinct participants ─────────────────────
blue "==> Creating $N_SESSIONS sessions on the single proxy"
declare -a SESSION_IDS=()
declare -a AGENT_PHONES=()
declare -a CUSTOMER_PHONES=()
declare -a PROXIES=()
TIMESTAMP=$(date +%s)

for i in $(seq 1 "$N_SESSIONS"); do
  AGENT="+234801$(printf '%07d' "$((TIMESTAMP % 1000000 + i))")"
  CUSTOMER="+234802$(printf '%07d' "$((TIMESTAMP % 1000000 + i))")"
  # Keep last 13 chars to stay under E.164's 15-char ceiling
  AGENT=${AGENT:0:14}
  CUSTOMER=${CUSTOMER:0:14}

  RESP=$(curl -sS -X POST "$BASE_URL/v1/sessions" \
    -H "$AUTH" -H "Content-Type: application/json" \
    -d "{\"agentPhone\":\"$AGENT\",\"customerPhone\":\"$CUSTOMER\",\"metadata\":{\"idx\":$i}}")

  SID=$(echo "$RESP" | jq -r '.id // empty')
  PROXY=$(echo "$RESP" | jq -r '.proxyNumber // empty')
  if [[ -z "$SID" || -z "$PROXY" ]]; then
    red "  ✗ session $i failed: $RESP"; exit 1
  fi
  AGENT_PHONES+=("$AGENT")
  CUSTOMER_PHONES+=("$CUSTOMER")
  SESSION_IDS+=("$SID")
  PROXIES+=("$PROXY")
  echo "  [$i] session=$SID  proxy=$PROXY  agent=$AGENT  customer=$CUSTOMER"
done

# ─── Step 4: assert all sessions share the one proxy ──────────────────────────
UNIQUE=$(printf "%s\n" "${PROXIES[@]}" | sort -u)
COUNT=$(echo "$UNIQUE" | wc -l | tr -d ' ')
if [[ "$COUNT" -ne 1 ]]; then
  red "  ✗ expected all $N_SESSIONS sessions on 1 proxy, got $COUNT unique:"
  echo "$UNIQUE"
  exit 1
fi
PROXY="${PROXIES[0]}"
green "  ✓ all $N_SESSIONS sessions share proxy $PROXY"

# ─── Step 5: route a call from agent1 ─────────────────────────────────────────
blue "==> Voice webhook: agent1 calls proxy → must connect to customer1"
RESP=$(curl -sS -X POST "$BASE_URL/v1/webhooks/cpaas/voice" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "sessionId=AT_MULTI_$$_1" \
  --data-urlencode "isActive=1" \
  --data-urlencode "direction=Inbound" \
  --data-urlencode "callerNumber=${AGENT_PHONES[0]}" \
  --data-urlencode "destinationNumber=$PROXY" \
  --data-urlencode "callSessionState=Ringing")
if [[ "$RESP" == *"<Dial"* && "$RESP" == *"${CUSTOMER_PHONES[0]}"* ]]; then
  green "  ✓ routed agent1 → customer1"
else
  red "  ✗ wrong routing"; echo "$RESP"; exit 1
fi

# ─── Step 6: route a call from customer3 ──────────────────────────────────────
blue "==> Voice webhook: customer3 calls proxy → must connect to agent3"
RESP=$(curl -sS -X POST "$BASE_URL/v1/webhooks/cpaas/voice" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "sessionId=AT_MULTI_$$_3" \
  --data-urlencode "isActive=1" \
  --data-urlencode "direction=Inbound" \
  --data-urlencode "callerNumber=${CUSTOMER_PHONES[2]}" \
  --data-urlencode "destinationNumber=$PROXY" \
  --data-urlencode "callSessionState=Ringing")
if [[ "$RESP" == *"<Dial"* && "$RESP" == *"${AGENT_PHONES[2]}"* ]]; then
  green "  ✓ routed customer3 → agent3"
else
  red "  ✗ wrong reverse routing"; echo "$RESP"; exit 1
fi

# ─── Step 7: try to create a 6th session reusing agent1 ───────────────────────
blue "==> Attempt 6th session reusing agent1's phone (overlap)"
RESP=$(curl -sS -o /tmp/relavoi-overlap.json -w '%{http_code}' \
  -X POST "$BASE_URL/v1/sessions" \
  -H "$AUTH" -H "Content-Type: application/json" \
  -d "{\"agentPhone\":\"${AGENT_PHONES[0]}\",\"customerPhone\":\"+2348099999999\"}")
BODY=$(cat /tmp/relavoi-overlap.json)
if [[ "$RESP" == "4"* || "$RESP" == "5"* || "$BODY" == *"pool"* || "$BODY" == *"overlap"* ]]; then
  green "  ✓ overlap correctly rejected (HTTP $RESP)"
else
  red "  ✗ overlap NOT rejected: HTTP $RESP body=$BODY"
  exit 1
fi

echo
green "==> Multi-session-proxy test PASSED"
