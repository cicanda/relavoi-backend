#!/usr/bin/env bash
# Force-expire a session through the normal lifecycle path.
#
# Never delete session rows in SQL: that strands the proxy number in Redis
# (pool:{region}:in_use plus a membership in proxy:{number}:sessions that
# release() counts), making the number permanently unreleasable. This calls
# SessionManager.expireSession(), which unwinds Redis, returns the proxy to
# cooldown and publishes session.expired.
#
# Usage, on the box:  ./scripts/expire-session.sh <session-id>
set -euo pipefail
SID="${1:-}"
[[ -z "$SID" ]] && { echo "usage: $0 <session-id>" >&2; exit 1; }

cd "$(dirname "$0")/.."
docker compose -f /opt/relavoi/docker-compose.yml exec -T api node -e "
const { getSessionManager } = require('./dist/services/session-manager');
const { connectDb, disconnectDb } = require('./dist/config/database');
const { disconnectRedis } = require('./dist/config/redis');
(async () => {
  await connectDb();
  const ok = await getSessionManager().expireSession('$SID');
  console.log(ok ? 'expired: $SID' : 'not found or already expired: $SID');
  await disconnectRedis().catch(() => {});
  await disconnectDb();
  process.exit(ok ? 0 : 1);
})();
"
