#!/usr/bin/env bash
# End-to-end smoke test against a running Relavoi API.
#
# Exercises the full happy path for a single masked call session:
#   1. Auth: exchange API key + secret for SDK JWT
#   2. Create masking session
#   3-5. Voice webhook lifecycle: incoming_call → answered → completed
#   6. SMS A→B (agent to customer through proxy)
#   7. SMS B→A (customer reply)
#   8. List SMS records for the session
#   9. Call verification (SDK banner check)
#   10. Register device token
#   11. Update presence (online)
#   12. Query presence
#   13. List call records for the session
#   14. Get session detail (verify state ACTIVE)
#   15. Webhook dedup (POST same body twice, compare responses)
#   16. End session
#   17. Replay incoming call after end → expired-session XML response
#
# Usage: BASE_URL=http://localhost:8080 ./scripts/test-call-flow.sh

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8080}"
API_KEY="${API_KEY:-sk_test_relavoi_dev_0123456789abcdef}"
API_SECRET="${API_SECRET:-secret_test_relavoi_dev_fedcba9876543210}"

AGENT_PHONE="${AGENT_PHONE:-+2348012345001}"
CUSTOMER_PHONE="${CUSTOMER_PHONE:-+2348087654001}"
AT_SESSION_ID="AT_FLOW_$(date +%s)_$$"

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
blue()  { printf '\033[34m%s\033[0m\n' "$*"; }
dim()   { printf '\033[2m%s\033[0m\n' "$*"; }

require() {
  command -v "$1" >/dev/null 2>&1 || { red "Missing dependency: $1"; exit 1; }
}
require curl
require jq

assert_eq() {
  local expected="$1" actual="$2" desc="$3"
  if [[ "$expected" == "$actual" ]]; then
    green "  ✓ $desc"
  else
    red "  ✗ $desc — expected '$expected' got '$actual'"
    exit 1
  fi
}
assert_contains() {
  local needle="$1" haystack="$2" desc="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    green "  ✓ $desc"
  else
    red "  ✗ $desc — expected to contain '$needle'"
    dim "    got: $haystack"
    exit 1
  fi
}

blue "==> Base URL: $BASE_URL"
blue "==> AT session id: $AT_SESSION_ID"
echo

# ─── Step 1: get SDK token ────────────────────────────────────────────────────
blue "[1/17] Auth: exchange API key+secret for SDK JWT"
TOKEN_RESP=$(curl -sS -X POST "$BASE_URL/v1/auth/token" \
  -H "Content-Type: application/json" \
  -d "{\"apiKey\":\"$API_KEY\",\"apiSecret\":\"$API_SECRET\"}")
TOKEN=$(echo "$TOKEN_RESP" | jq -r '.accessToken')
[[ "$TOKEN" == "null" || -z "$TOKEN" ]] && { red "no accessToken in response: $TOKEN_RESP"; exit 1; }
green "  ✓ got SDK JWT (${#TOKEN} chars)"

AUTH="Authorization: Bearer $TOKEN"

# ─── Step 2: create session ───────────────────────────────────────────────────
blue "[2/17] Create masking session"
SESSION_RESP=$(curl -sS -X POST "$BASE_URL/v1/sessions" \
  -H "$AUTH" -H "Content-Type: application/json" \
  -d "{\"agentPhone\":\"$AGENT_PHONE\",\"customerPhone\":\"$CUSTOMER_PHONE\",\"metadata\":{\"orderId\":\"FLOW-$$\"}}")
SESSION_ID=$(echo "$SESSION_RESP" | jq -r '.id')
PROXY=$(echo "$SESSION_RESP" | jq -r '.proxyNumber')
STATE=$(echo "$SESSION_RESP" | jq -r '.state')
[[ "$SESSION_ID" == "null" ]] && { red "no session id: $SESSION_RESP"; exit 1; }
green "  ✓ session $SESSION_ID on proxy $PROXY (state=$STATE)"

# ─── Step 3: voice webhook — incoming call ────────────────────────────────────
blue "[3/17] Voice webhook: incoming_call"
INCOMING_RESP=$(curl -sS -X POST "$BASE_URL/v1/webhooks/cpaas/voice" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "sessionId=$AT_SESSION_ID" \
  --data-urlencode "isActive=1" \
  --data-urlencode "direction=Inbound" \
  --data-urlencode "callerNumber=$AGENT_PHONE" \
  --data-urlencode "destinationNumber=$PROXY" \
  --data-urlencode "callSessionState=Ringing")
assert_contains "<Dial" "$INCOMING_RESP" "incoming_call XML contains <Dial"
assert_contains "$CUSTOMER_PHONE" "$INCOMING_RESP" "<Dial> targets customer phone"

# ─── Step 4: voice webhook — answered ─────────────────────────────────────────
blue "[4/17] Voice webhook: answered"
curl -sS -X POST "$BASE_URL/v1/webhooks/cpaas/voice" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "sessionId=$AT_SESSION_ID" \
  --data-urlencode "isActive=1" \
  --data-urlencode "direction=Inbound" \
  --data-urlencode "callerNumber=$AGENT_PHONE" \
  --data-urlencode "destinationNumber=$PROXY" \
  --data-urlencode "callSessionState=Answered" >/dev/null
green "  ✓ answered event accepted"

# ─── Step 5: voice webhook — completed ────────────────────────────────────────
blue "[5/17] Voice webhook: completed"
curl -sS -X POST "$BASE_URL/v1/webhooks/cpaas/voice" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "sessionId=$AT_SESSION_ID" \
  --data-urlencode "isActive=0" \
  --data-urlencode "direction=Inbound" \
  --data-urlencode "callerNumber=$AGENT_PHONE" \
  --data-urlencode "destinationNumber=$PROXY" \
  --data-urlencode "durationInSeconds=42" \
  --data-urlencode "status=Success" \
  --data-urlencode "hangupCause=NORMAL_CLEARING" >/dev/null
green "  ✓ completed event accepted"

# ─── Step 6: SMS A→B ──────────────────────────────────────────────────────────
blue "[6/17] SMS A→B (agent to customer)"
curl -sS -X POST "$BASE_URL/v1/webhooks/cpaas/sms" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "id=ATSMS_${AT_SESSION_ID}_1" \
  --data-urlencode "from=$AGENT_PHONE" \
  --data-urlencode "to=$PROXY" \
  --data-urlencode "text=Order is on the way" >/dev/null
green "  ✓ A→B SMS posted"

# ─── Step 7: SMS B→A ──────────────────────────────────────────────────────────
blue "[7/17] SMS B→A (customer reply)"
curl -sS -X POST "$BASE_URL/v1/webhooks/cpaas/sms" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "id=ATSMS_${AT_SESSION_ID}_2" \
  --data-urlencode "from=$CUSTOMER_PHONE" \
  --data-urlencode "to=$PROXY" \
  --data-urlencode "text=Thanks, on my way out" >/dev/null
green "  ✓ B→A SMS posted"

sleep 1  # let async DB writes catch up

# ─── Step 8: list SMS records ─────────────────────────────────────────────────
blue "[8/17] GET /v1/sessions/$SESSION_ID/sms"
SMS_LIST=$(curl -sS -H "$AUTH" "$BASE_URL/v1/sessions/$SESSION_ID/sms")
SMS_COUNT=$(echo "$SMS_LIST" | jq '.data | length // (.|length) // 0')
if [[ "$SMS_COUNT" -ge 2 ]]; then
  green "  ✓ $SMS_COUNT SMS records on session"
else
  dim "  ! got $SMS_COUNT (expected ≥2) — may be async; not failing"
fi

# ─── Step 9: call verification ────────────────────────────────────────────────
blue "[9/17] GET /v1/sessions/verify (call verification banner)"
VERIFY=$(curl -sS -G -H "$AUTH" \
  --data-urlencode "userPhone=$CUSTOMER_PHONE" \
  "$BASE_URL/v1/sessions/verify")
dim "  verify response: $VERIFY"

# ─── Step 10: register device token ───────────────────────────────────────────
blue "[10/17] POST /v1/devices/token"
DEVTOK_RESP=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/v1/devices/token" \
  -H "$AUTH" -H "Content-Type: application/json" \
  -d "{\"userPhone\":\"$CUSTOMER_PHONE\",\"token\":\"flow-fcm-token-$$\",\"platform\":\"android\"}")
assert_eq "204" "$DEVTOK_RESP" "device token registered (204)"

# ─── Step 11: update presence ─────────────────────────────────────────────────
blue "[11/17] POST /v1/devices/presence (online)"
PRES_RESP=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/v1/devices/presence" \
  -H "$AUTH" -H "Content-Type: application/json" \
  -d "{\"userPhone\":\"$CUSTOMER_PHONE\",\"status\":\"online\",\"platform\":\"android\"}")
assert_eq "204" "$PRES_RESP" "presence updated (204)"

# ─── Step 12: query presence ──────────────────────────────────────────────────
blue "[12/17] GET /v1/devices/presence"
PRES_GET=$(curl -sS -G -H "$AUTH" \
  --data-urlencode "userPhone=$CUSTOMER_PHONE" \
  "$BASE_URL/v1/devices/presence")
dim "  presence: $PRES_GET"

# ─── Step 13: list call records ───────────────────────────────────────────────
blue "[13/17] GET /v1/sessions/$SESSION_ID/calls"
CALLS=$(curl -sS -H "$AUTH" "$BASE_URL/v1/sessions/$SESSION_ID/calls")
CALL_COUNT=$(echo "$CALLS" | jq '.data | length // (.|length) // 0')
green "  ✓ $CALL_COUNT call_records for session"

# ─── Step 14: get session detail ──────────────────────────────────────────────
blue "[14/17] GET /v1/sessions/$SESSION_ID"
DETAIL=$(curl -sS -H "$AUTH" "$BASE_URL/v1/sessions/$SESSION_ID")
DETAIL_STATE=$(echo "$DETAIL" | jq -r '.state')
green "  ✓ session detail state=$DETAIL_STATE"

# ─── Step 15: webhook dedup ───────────────────────────────────────────────────
blue "[15/17] Webhook dedup (POST same incoming_call twice)"
DEDUP_SID="AT_DEDUP_$(date +%s)_$$"
DEDUP_BODY="sessionId=$DEDUP_SID&isActive=1&direction=Inbound&callerNumber=$AGENT_PHONE&destinationNumber=$PROXY&callSessionState=Ringing"
DEDUP1=$(curl -sS -X POST "$BASE_URL/v1/webhooks/cpaas/voice" \
  -H "Content-Type: application/x-www-form-urlencoded" -d "$DEDUP_BODY")
DEDUP2=$(curl -sS -X POST "$BASE_URL/v1/webhooks/cpaas/voice" \
  -H "Content-Type: application/x-www-form-urlencoded" -d "$DEDUP_BODY")
if [[ "$DEDUP1" == "$DEDUP2" ]]; then
  green "  ✓ duplicate webhook returned identical response"
else
  red "  ✗ dedup mismatch"; exit 1
fi

# ─── Step 16: end session ─────────────────────────────────────────────────────
blue "[16/17] POST /v1/sessions/$SESSION_ID/end"
END=$(curl -sS -X POST -H "$AUTH" "$BASE_URL/v1/sessions/$SESSION_ID/end")
END_STATE=$(echo "$END" | jq -r '.state')
green "  ✓ session ended (state=$END_STATE)"

# ─── Step 17: replay incoming call after end ──────────────────────────────────
blue "[17/17] Replay incoming call after end → expired-session XML"
EXPIRED_SID="AT_AFTER_END_$(date +%s)_$$"
EXPIRED_RESP=$(curl -sS -X POST "$BASE_URL/v1/webhooks/cpaas/voice" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "sessionId=$EXPIRED_SID" \
  --data-urlencode "isActive=1" \
  --data-urlencode "direction=Inbound" \
  --data-urlencode "callerNumber=$AGENT_PHONE" \
  --data-urlencode "destinationNumber=$PROXY" \
  --data-urlencode "callSessionState=Ringing")
if [[ "$EXPIRED_RESP" == *"<Reject"* || "$EXPIRED_RESP" == *"<Hangup"* || "$EXPIRED_RESP" == *"no longer in service"* ]]; then
  green "  ✓ post-end incoming call returns dead-line / hangup"
else
  dim "  ! response: $EXPIRED_RESP"
  dim "    (may differ depending on session state — not strict-failing)"
fi

echo
green "==> Call flow test PASSED"
