import { getRedis } from '../config/redis';
import { getDb } from '../config/database';
import { config } from '../config/env';
import { logger } from '../utils/logger';
import { numberPoolAvailable, numberPoolUtilization } from '../utils/metrics';

/**
 * NumberPool — atomic proxy number allocation using Redis Lua.
 *
 * Redis layout (all keys are auto-prefixed by ioredis with REDIS_PREFIX):
 *   pool:{region}:available           Set of available proxy numbers
 *   pool:{region}:in_use              Set of proxy numbers currently in use
 *   pool:{region}:cooldown            ZSET<proxy_number, available_at_epoch_ms>
 *   pool:{region}:total               Counter of total provisioned numbers
 *   proxy:{number}:sessions           Set of session ids on this proxy
 *   proxy:{number}:region             String — region of this proxy
 *   proxy:{number}:provider           String — provider of this proxy
 *   phone:{hash}:sessions             Set of session ids the user participates in
 *
 * IMPORTANT: ioredis prepends the keyPrefix to each KEYS[] entry passed to
 * EVAL/EVALSHA automatically, so the Lua script must not redo that.
 */

const DEFAULT_REGION = 'lagos';

/**
 * Atomic allocation script.
 * Picks a candidate from pool:{region}:available, checks against all sessions
 * currently on that proxy for participant overlap. If overlap, retries with
 * another candidate up to a limit. If none found, returns "" (nil).
 *
 * KEYS[1] = pool:{region}:available
 * KEYS[2] = pool:{region}:in_use
 * ARGV[1] = party_a_hash
 * ARGV[2] = party_b_hash
 * ARGV[3] = session_id
 * ARGV[4] = max_attempts
 *
 * Returns: allocated proxy_number string, or "" if none available without overlap.
 */
// NOTE: ARGV[5] = keyPrefix. ioredis auto-prefixes keys passed via KEYS[] but
// NOT dynamic keys constructed inside Lua. We pass the prefix explicitly and
// prepend it to every dynamic key so JS-side reads (which DO get prefixed)
// hit the same slots.
const ALLOCATE_SCRIPT = `
local pool_avail = KEYS[1]
local pool_in_use = KEYS[2]
local party_a = ARGV[1]
local party_b = ARGV[2]
local sid = ARGV[3]
local max_attempts = tonumber(ARGV[4]) or 8
local prefix = ARGV[5] or ''

local tried = {}
for attempt = 1, max_attempts do
  local candidate = redis.call('SRANDMEMBER', pool_avail)
  if not candidate then
    break
  end
  if tried[candidate] then
    -- skip duplicates from SRANDMEMBER
  else
    tried[candidate] = true
    local overlap = false
    local existing = redis.call('SMEMBERS', prefix .. 'proxy:' .. candidate .. ':sessions')
    for _, esid in ipairs(existing) do
      local pa = redis.call('HGET', prefix .. 'session:' .. esid, 'party_a_hash')
      local pb = redis.call('HGET', prefix .. 'session:' .. esid, 'party_b_hash')
      if pa == party_a or pa == party_b or pb == party_a or pb == party_b then
        overlap = true
        break
      end
    end
    if not overlap then
      local sess_count = redis.call('SCARD', prefix .. 'proxy:' .. candidate .. ':sessions')
      if sess_count == 0 then
        redis.call('SREM', pool_avail, candidate)
        redis.call('SADD', pool_in_use, candidate)
      end
      redis.call('SADD', prefix .. 'proxy:' .. candidate .. ':sessions', sid)
      redis.call('SADD', prefix .. 'phone:' .. party_a .. ':sessions', sid)
      redis.call('SADD', prefix .. 'phone:' .. party_b .. ':sessions', sid)
      return candidate
    end
  end
end

local in_use_members = redis.call('SMEMBERS', pool_in_use)
for _, candidate in ipairs(in_use_members) do
  if not tried[candidate] then
    tried[candidate] = true
    local overlap = false
    local existing = redis.call('SMEMBERS', prefix .. 'proxy:' .. candidate .. ':sessions')
    for _, esid in ipairs(existing) do
      local pa = redis.call('HGET', prefix .. 'session:' .. esid, 'party_a_hash')
      local pb = redis.call('HGET', prefix .. 'session:' .. esid, 'party_b_hash')
      if pa == party_a or pa == party_b or pb == party_a or pb == party_b then
        overlap = true
        break
      end
    end
    if not overlap then
      redis.call('SADD', prefix .. 'proxy:' .. candidate .. ':sessions', sid)
      redis.call('SADD', prefix .. 'phone:' .. party_a .. ':sessions', sid)
      redis.call('SADD', prefix .. 'phone:' .. party_b .. ':sessions', sid)
      return candidate
    end
  end
end

return ""
`;

/**
 * Release a session's claim on its proxy. If the proxy has no other sessions,
 * move it to cooldown (cooldown_until = now + cooldownMinutes). When cooldown
 * elapses it will be returned to pool by reapCooldown().
 *
 * KEYS[1] = pool:{region}:available
 * KEYS[2] = pool:{region}:in_use
 * KEYS[3] = pool:{region}:cooldown
 * ARGV[1] = proxy_number
 * ARGV[2] = session_id
 * ARGV[3] = cooldown_until_epoch_ms (string)
 *
 * Returns: 1 if number was returned to cooldown, 0 if still in use.
 */
// ARGV[4] = keyPrefix (see ALLOCATE_SCRIPT note about dynamic-key prefixing).
const RELEASE_SCRIPT = `
local pool_avail = KEYS[1]
local pool_in_use = KEYS[2]
local pool_cd = KEYS[3]
local proxy = ARGV[1]
local sid = ARGV[2]
local cd_until = tonumber(ARGV[3])
local prefix = ARGV[4] or ''

redis.call('SREM', prefix .. 'proxy:' .. proxy .. ':sessions', sid)
local remaining = redis.call('SCARD', prefix .. 'proxy:' .. proxy .. ':sessions')
if remaining == 0 then
  redis.call('SREM', pool_in_use, proxy)
  redis.call('SREM', pool_avail, proxy)
  if cd_until > 0 then
    redis.call('ZADD', pool_cd, cd_until, proxy)
  else
    redis.call('SADD', pool_avail, proxy)
  end
  return 1
end
return 0
`;

export interface AllocateArgs {
  region?: string;
  partyAHash: string;
  partyBHash: string;
  sessionId: string;
}

export interface ReleaseArgs {
  proxyNumber: string;
  sessionId: string;
  region?: string;
  cooldownMinutes?: number;
}

export interface PoolStatusRow {
  region: string;
  provider: string;
  total: number;
  available: number;
  inUse: number;
  cooldown: number;
}

export class NumberPool {
  private readonly redis = getRedis();

  async allocate(args: AllocateArgs): Promise<string | null> {
    const region = args.region ?? DEFAULT_REGION;
    const keyAvail = `pool:${region}:available`;
    const keyInUse = `pool:${region}:in_use`;

    try {
      const result = (await this.redis.eval(
        ALLOCATE_SCRIPT,
        2,
        keyAvail,
        keyInUse,
        args.partyAHash,
        args.partyBHash,
        args.sessionId,
        '8',
        config.REDIS_PREFIX,
      )) as string;

      if (!result || result === '') {
        logger.warn({ region, sessionId: args.sessionId }, 'NumberPool: no proxy available');
        return null;
      }

      // Refresh metrics async (non-blocking)
      this.refreshMetrics(region).catch((err) =>
        logger.debug({ err }, 'NumberPool metrics refresh failed'),
      );

      return result;
    } catch (err) {
      logger.error({ err, region, sessionId: args.sessionId }, 'NumberPool: allocation failed');
      return null;
    }
  }

  async release(args: ReleaseArgs): Promise<boolean> {
    const region = args.region ?? (await this.getProxyRegion(args.proxyNumber)) ?? DEFAULT_REGION;
    const cooldownMinutes = args.cooldownMinutes ?? config.POOL_COOLDOWN_MINUTES;
    const cooldownUntilMs = cooldownMinutes > 0 ? Date.now() + cooldownMinutes * 60_000 : 0;

    const keyAvail = `pool:${region}:available`;
    const keyInUse = `pool:${region}:in_use`;
    const keyCd = `pool:${region}:cooldown`;

    try {
      const returned = (await this.redis.eval(
        RELEASE_SCRIPT,
        3,
        keyAvail,
        keyInUse,
        keyCd,
        args.proxyNumber,
        args.sessionId,
        String(cooldownUntilMs),
        config.REDIS_PREFIX,
      )) as number;

      // Persist DB cooldown timestamp best-effort
      if (returned === 1) {
        try {
          const db = getDb();
          await db('proxy_numbers')
            .where({ number: args.proxyNumber })
            .update({
              status: cooldownUntilMs > 0 ? 'COOLDOWN' : 'AVAILABLE',
              cooldown_until: cooldownUntilMs > 0 ? new Date(cooldownUntilMs) : null,
              last_used_at: new Date(),
            });
        } catch (dbErr) {
          logger.warn({ err: dbErr }, 'NumberPool: DB cooldown update failed');
        }
      }

      this.refreshMetrics(region).catch(() => undefined);
      return returned === 1;
    } catch (err) {
      logger.error({ err, proxy: args.proxyNumber }, 'NumberPool: release failed');
      return false;
    }
  }

  async reapCooldown(region: string = DEFAULT_REGION): Promise<number> {
    const keyCd = `pool:${region}:cooldown`;
    const keyAvail = `pool:${region}:available`;
    const now = Date.now();

    try {
      const expired = await this.redis.zrangebyscore(keyCd, 0, now);
      if (!expired.length) return 0;

      const pipeline = this.redis.pipeline();
      for (const proxy of expired) {
        pipeline.zrem(keyCd, proxy);
        pipeline.sadd(keyAvail, proxy);
      }
      await pipeline.exec();

      // DB: mark as AVAILABLE
      try {
        const db = getDb();
        await db('proxy_numbers')
          .whereIn('number', expired)
          .update({ status: 'AVAILABLE', cooldown_until: null });
      } catch (dbErr) {
        logger.warn({ err: dbErr }, 'NumberPool: DB reap update failed');
      }

      this.refreshMetrics(region).catch(() => undefined);
      return expired.length;
    } catch (err) {
      logger.error({ err, region }, 'NumberPool: reap failed');
      return 0;
    }
  }

  async getPoolStatus(region?: string): Promise<PoolStatusRow[]> {
    const db = getDb();
    const query = db('proxy_numbers')
      .select('region', 'provider', 'status')
      .count<{ region: string; provider: string; status: string; count: string }[]>('* as count')
      .groupBy('region', 'provider', 'status');

    if (region) query.where({ region });

    const rows = await query;

    const map = new Map<string, PoolStatusRow>();
    for (const r of rows) {
      const key = `${r.region}::${r.provider}`;
      let row = map.get(key);
      if (!row) {
        row = {
          region: r.region,
          provider: r.provider,
          total: 0,
          available: 0,
          inUse: 0,
          cooldown: 0,
        };
        map.set(key, row);
      }
      const count = Number(r.count);
      row.total += count;
      if (r.status === 'AVAILABLE') row.available += count;
      else if (r.status === 'IN_USE') row.inUse += count;
      else if (r.status === 'COOLDOWN') row.cooldown += count;
    }

    // Cross-check Redis available count for each region (Redis is the hot source of truth)
    for (const row of map.values()) {
      try {
        const liveAvail = await this.redis.scard(`pool:${row.region}:available`);
        const liveInUse = await this.redis.scard(`pool:${row.region}:in_use`);
        const liveCd = await this.redis.zcard(`pool:${row.region}:cooldown`);
        // Prefer live Redis numbers if they differ from DB (Redis leads)
        row.available = liveAvail;
        row.inUse = liveInUse;
        row.cooldown = liveCd;
      } catch (err) {
        logger.debug({ err, region: row.region }, 'NumberPool: live count failed');
      }
    }

    return Array.from(map.values());
  }

  /**
   * Sync Redis sets from proxy_numbers table. Idempotent — safe to run on boot.
   */
  async loadPoolFromDb(): Promise<{ loaded: number; regions: string[] }> {
    const db = getDb();
    const rows = await db('proxy_numbers').select(
      'number',
      'region',
      'status',
      'provider',
      'cooldown_until',
    );

    // Reconcile against live sessions: a proxy held by an ACTIVE/GRACE_PERIOD
    // session is really in use even though proxy_numbers.status is not updated
    // on allocate (allocation only mutates Redis). Without this, a reboot
    // re-adds an in-use number to the available pool, so the pool counts drift
    // and a number could be handed out from under an active session.
    const heldRows = await db('sessions')
      .whereIn('state', ['ACTIVE', 'GRACE_PERIOD'])
      .distinct('proxy_number');
    const heldProxies = new Set<string>(heldRows.map((h) => h.proxy_number as string));

    const regions = new Set<string>();
    const pipeline = this.redis.pipeline();

    for (const r of rows) {
      const region = r.region ?? DEFAULT_REGION;
      regions.add(region);

      // Always set provider/region pointers for routing
      pipeline.set(`proxy:${r.number}:region`, region);
      pipeline.set(`proxy:${r.number}:provider`, r.provider ?? 'AFRICASTALKING');

      // A number a live session is holding is in_use regardless of DB status,
      // unless it has been quarantined (quarantine wins for safety).
      if (heldProxies.has(r.number) && r.status !== 'QUARANTINED') {
        pipeline.sadd(`pool:${region}:in_use`, r.number);
        pipeline.srem(`pool:${region}:available`, r.number);
        pipeline.zrem(`pool:${region}:cooldown`, r.number);
      } else if (r.status === 'AVAILABLE') {
        pipeline.sadd(`pool:${region}:available`, r.number);
        pipeline.srem(`pool:${region}:in_use`, r.number);
        pipeline.zrem(`pool:${region}:cooldown`, r.number);
      } else if (r.status === 'IN_USE') {
        pipeline.sadd(`pool:${region}:in_use`, r.number);
        pipeline.srem(`pool:${region}:available`, r.number);
        pipeline.zrem(`pool:${region}:cooldown`, r.number);
      } else if (r.status === 'COOLDOWN') {
        const until = r.cooldown_until ? new Date(r.cooldown_until).getTime() : Date.now();
        pipeline.zadd(`pool:${region}:cooldown`, until, r.number);
        pipeline.srem(`pool:${region}:available`, r.number);
        pipeline.srem(`pool:${region}:in_use`, r.number);
      } else {
        // QUARANTINED — leave out of all sets
        pipeline.srem(`pool:${region}:available`, r.number);
        pipeline.srem(`pool:${region}:in_use`, r.number);
        pipeline.zrem(`pool:${region}:cooldown`, r.number);
      }
    }

    await pipeline.exec();

    for (const region of regions) {
      this.refreshMetrics(region).catch(() => undefined);
    }

    logger.info({ loaded: rows.length, regions: Array.from(regions) }, 'NumberPool: loaded from DB');

    return { loaded: rows.length, regions: Array.from(regions) };
  }

  private async getProxyRegion(proxy: string): Promise<string | null> {
    try {
      const r = await this.redis.get(`proxy:${proxy}:region`);
      return r;
    } catch {
      return null;
    }
  }

  private async refreshMetrics(region: string): Promise<void> {
    const avail = await this.redis.scard(`pool:${region}:available`);
    const inUse = await this.redis.scard(`pool:${region}:in_use`);
    const cd = await this.redis.zcard(`pool:${region}:cooldown`);
    const total = avail + inUse + cd;

    numberPoolAvailable.set({ region, provider: 'AFRICASTALKING' }, avail);
    if (total > 0) {
      numberPoolUtilization.set({ region }, (inUse / total) * 100);
    } else {
      numberPoolUtilization.set({ region }, 0);
    }
  }
}

let instance: NumberPool | null = null;
export function getNumberPool(): NumberPool {
  if (!instance) instance = new NumberPool();
  return instance;
}
