#!/usr/bin/env bash
# Run all k6 load tests in sequence, writing JSON+text results to ./results.
#
# Usage: BASE_URL=http://localhost:3000 ./loadtest/run-all.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RESULTS_DIR="$SCRIPT_DIR/results"
mkdir -p "$RESULTS_DIR"

BASE_URL="${BASE_URL:-http://localhost:3000}"
export BASE_URL

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
blue()  { printf '\033[34m%s\033[0m\n' "$*"; }

if ! command -v k6 >/dev/null 2>&1; then
  red "k6 is not installed. Install from https://k6.io/docs/get-started/installation/"
  exit 1
fi

run_one() {
  local name="$1"
  local script="$2"
  local out="$RESULTS_DIR/${name}_$(date +%Y%m%d_%H%M%S)"
  blue "==> running $name"
  k6 run \
    --summary-export "${out}.json" \
    "$script" 2>&1 | tee "${out}.log" \
    || red "  $name FAILED — see ${out}.log"
}

run_one "auth"             "$SCRIPT_DIR/auth.js"
run_one "session-lifecycle" "$SCRIPT_DIR/session-lifecycle.js"
run_one "webhook-routing"   "$SCRIPT_DIR/webhook-routing.js"

green "==> done; results in $RESULTS_DIR"
