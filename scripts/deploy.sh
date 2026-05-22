#!/usr/bin/env bash
# Deploy pipeline placeholder.
#
# Steps:
#   1) Validate required environment variables
#   2) Run TypeScript build
#   3) Build the Docker image
#   4) (Optional) tag and push to registry — only if REGISTRY env is set
#
# Usage:
#   ./scripts/deploy.sh
#   REGISTRY=ghcr.io/relavoi VERSION=1.2.3 ./scripts/deploy.sh

set -euo pipefail

VERSION="${VERSION:-$(date +%Y%m%d-%H%M%S)}"
IMAGE_NAME="${IMAGE_NAME:-relavoi-api}"
REGISTRY="${REGISTRY:-}"

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
blue()  { printf '\033[34m%s\033[0m\n' "$*"; }
yellow(){ printf '\033[33m%s\033[0m\n' "$*"; }

# ─── 1. Validate env ──────────────────────────────────────────────────────────
blue "==> Validating environment"

REQUIRED_VARS=(JWT_SECRET ENCRYPTION_MASTER_KEY DATABASE_URL AT_API_KEY)
MISSING=0
for v in "${REQUIRED_VARS[@]}"; do
  if [ -z "${!v:-}" ]; then
    yellow "  - $v not set (will need to be provided to runtime via secrets)"
    MISSING=$((MISSING+1))
  fi
done
if [ "$MISSING" -gt 0 ]; then
  yellow "  ($MISSING required vars missing — proceeding for build only)"
else
  green "  all required vars present"
fi

# ─── 2. Build ─────────────────────────────────────────────────────────────────
blue "==> Building TypeScript"
if [ -f package.json ]; then
  npm run build
  green "  build complete"
else
  red "  no package.json found"; exit 1
fi

# ─── 3. Docker build ──────────────────────────────────────────────────────────
blue "==> Building Docker image $IMAGE_NAME:$VERSION"
if ! command -v docker >/dev/null 2>&1; then
  red "  docker not installed"; exit 1
fi

docker build -f docker/Dockerfile -t "$IMAGE_NAME:$VERSION" -t "$IMAGE_NAME:latest" .
green "  image built: $IMAGE_NAME:$VERSION"

# ─── 4. Optional registry push ────────────────────────────────────────────────
if [ -n "$REGISTRY" ]; then
  REMOTE="$REGISTRY/$IMAGE_NAME:$VERSION"
  REMOTE_LATEST="$REGISTRY/$IMAGE_NAME:latest"
  blue "==> Pushing to $REGISTRY"
  docker tag "$IMAGE_NAME:$VERSION" "$REMOTE"
  docker tag "$IMAGE_NAME:latest"   "$REMOTE_LATEST"
  docker push "$REMOTE"
  docker push "$REMOTE_LATEST"
  green "  pushed $REMOTE"
else
  yellow "==> REGISTRY env not set — skipping push"
fi

green "==> Deploy script complete (version: $VERSION)"
exit 0
