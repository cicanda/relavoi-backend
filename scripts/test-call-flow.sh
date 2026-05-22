#!/usr/bin/env bash
# End-to-end smoke test against a running Relavoi API.
#
# Steps:
#   1) Obtain an SDK JWT using the dev tenant API key + secret
#   2) Create a masking session (returns proxy number)
#   3) Simulate an inbound Africa's Talking voice webhook on that proxy
#   4) Verify the call from the SDK perspective (/sessions/verify)
#   5) End the session
#
# Usage: BASE_URL=http://localhost:3000 ./scripts/test-call-flow.sh

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
API_KEY="${API_KEY:-sk_test_relavoi_dev_0123456789abcdef}"
API_SECRET="${API_SECRET:-secret_test_relavoi_dev_fedcba9876543210}"

AGENT_PHONE="${AGENT_PHONE:-+2348012345001}"
CUSTOMER_PHONE="${CUSTOMER_PHONE:-+2348087654001}"

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
blue()  { printf '\033[34m%s\033[0m\n' "$*"; }

require() {
  command -v "$1" >/dev/null 2>&1 || { red "Missing dependency: $1"; exit 1; }
}

require curl
require jq

blue "==> Base URL: $BASE_URL"

# ─── 1. Auth ──────────────────────────────────────────────────────────────────
blue "==> Step 1: get SDK token"
TOKEN_RESP=$(curl -sS -X POST "$BASE_URL/v1/auth/token" \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -H "x-api-secret: $API_SECRET" \
  -d '{}')

echo "$TOKEN_RESP" | jq .
TOKEN=$(echo "$TOKEN_RESP" | jq -r '.token // .access_token // empty')
if [ -z "$TOKEN" ]; then
  red "Failed to obtain token"; exit 1
fi
green "OK — got token"

# ─── 2. Create session ────────────────────────────────────────────────────────
blue "==> Step 2: create session"
SESSION_RESP=$(curl -sS -X POST "$BASE_URL/v1/sessions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{
    \"agentPhone\":\"$AGENT_PHONE\",
    \"customerPhone\":\"$CUSTOMER_PHONE\",
    \"metadata\":{\"orderId\":\"TEST-$(date +%s)\"},
    \"gracePeriodMinutes\":5,
    \"directionMode\":\"BIDIRECTIONAL\"
  }")

echo "$SESSION_RESP" | jq .
SESSION_ID=$(echo "$SESSION_RESP" | jq -r '.id // .session.id // empty')
PROXY=$(echo "$SESSION_RESP" | jq -r '.proxyNumber // .proxy_number // .session.proxyNumber // empty')
if [ -z "$SESSION_ID" ] || [ -z "$PROXY" ]; then
  red "Session creation failed"; exit 1
fi
green "OK — session $SESSION_ID via proxy $PROXY"

# ─── 3. Simulate inbound voice webhook ────────────────────────────────────────
blue "==> Step 3: simulate inbound AT voice webhook on $PROXY"
WEBHOOK_RESP=$(curl -sS -X POST "$BASE_URL/v1/webhooks/cpaas/voice" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "sessionId=AT-CALL-$(date +%s)" \
  --data-urlencode "isActive=1" \
  --data-urlencode "direction=Inbound" \
  --data-urlencode "callerNumber=$AGENT_PHONE" \
  --data-urlencode "destinationNumber=$PROXY" \
  --data-urlencode "callSessionState=Ringing")

echo "$WEBHOOK_RESP"
green "OK — webhook responded"

# ─── 4. Verify ────────────────────────────────────────────────────────────────
blue "==> Step 4: verify call (SDK banner)"
PHONE_HASH=$(printf "%s" "$AGENT_PHONE" | openssl dgst -sha256 -hmac "$API_KEY" -hex | awk '{print $2}' || true)
VERIFY_RESP=$(curl -sS "$BASE_URL/v1/sessions/verify?user_phone=$AGENT_PHONE" \
  -H "Authorization: Bearer $TOKEN") || true
echo "$VERIFY_RESP" | jq . || echo "$VERIFY_RESP"

# ─── 5. End session ───────────────────────────────────────────────────────────
blue "==> Step 5: end session"
END_RESP=$(curl -sS -X POST "$BASE_URL/v1/sessions/$SESSION_ID/end" \
  -H "Authorization: Bearer $TOKEN")
echo "$END_RESP" | jq .
green "OK — call flow complete"
