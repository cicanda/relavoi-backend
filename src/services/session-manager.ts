import { randomUUID } from 'crypto';
import { getDb } from '../config/database';
import { getRedis } from '../config/redis';
import { config } from '../config/env';
import { logger } from '../utils/logger';
import { encryptPhone, hashPhone } from '../utils/crypto';
import { activeSessionsGauge, sessionCreatedTotal } from '../utils/metrics';
import { getNumberPool } from './number-pool';

/** E.164 (+ followed by 8-15 digits). */
const E164_RE = /^\+[1-9]\d{7,14}$/;

export type SessionState = 'PENDING' | 'ACTIVE' | 'GRACE_PERIOD' | 'EXPIRED' | 'FAILED';
export type DirectionMode = 'BIDIRECTIONAL' | 'A_TO_B_ONLY' | 'B_TO_A_ONLY';
export type ConsentPrompt = 'DEFAULT' | 'CUSTOM' | 'NONE';

export interface Session {
  id: string;
  tenantId: string;
  partyAPhoneEnc: Buffer;
  partyBPhoneEnc: Buffer;
  partyAPhoneHash: string;
  partyBPhoneHash: string;
  proxyNumber: string;
  state: SessionState;
  directionMode: DirectionMode;
  metadata: Record<string, unknown>;
  gracePeriodMin: number;
  maxDurationMin: number;
  recordingEnabled: boolean;
  consentPrompt: ConsentPrompt;
  expiresAt: Date;
  createdAt: Date;
  activatedAt: Date | null;
  endedAt: Date | null;
  expiredAt: Date | null;
  callCount: number;
  lastCallAt: Date | null;
}

export interface CreateSessionArgs {
  tenantId: string;
  agentPhone: string;
  customerPhone: string;
  metadata?: Record<string, unknown>;
  gracePeriodMinutes?: number;
  maxDurationMinutes?: number;
  directionMode?: DirectionMode;
  recordingEnabled?: boolean;
  consentPrompt?: ConsentPrompt;
  region?: string;
}

export interface ListSessionsOptions {
  state?: SessionState;
  limit?: number;
  after?: string;
}

export interface SessionError extends Error {
  statusCode: number;
  code: string;
}

function err(code: string, statusCode: number, message: string): SessionError {
  const e = new Error(message) as SessionError;
  e.code = code;
  e.statusCode = statusCode;
  return e;
}

interface DbSessionRow {
  id: string;
  tenant_id: string;
  party_a_phone_enc: Buffer;
  party_b_phone_enc: Buffer;
  party_a_phone_hash: string;
  party_b_phone_hash: string;
  proxy_number: string;
  state: SessionState;
  direction_mode: DirectionMode;
  metadata: Record<string, unknown> | string | null;
  grace_period_min: number;
  max_duration_min: number;
  recording_enabled: boolean;
  consent_prompt: ConsentPrompt;
  expires_at: Date | string;
  created_at: Date | string;
  activated_at: Date | string | null;
  ended_at: Date | string | null;
  expired_at: Date | string | null;
  call_count: number;
  last_call_at: Date | string | null;
}

function rowToSession(r: DbSessionRow): Session {
  const meta =
    typeof r.metadata === 'string' ? (JSON.parse(r.metadata) as Record<string, unknown>) : (r.metadata ?? {});
  return {
    id: r.id,
    tenantId: r.tenant_id,
    partyAPhoneEnc: r.party_a_phone_enc,
    partyBPhoneEnc: r.party_b_phone_enc,
    partyAPhoneHash: r.party_a_phone_hash,
    partyBPhoneHash: r.party_b_phone_hash,
    proxyNumber: r.proxy_number,
    state: r.state,
    directionMode: r.direction_mode,
    metadata: meta,
    gracePeriodMin: r.grace_period_min,
    maxDurationMin: r.max_duration_min,
    recordingEnabled: r.recording_enabled,
    consentPrompt: r.consent_prompt,
    expiresAt: new Date(r.expires_at),
    createdAt: new Date(r.created_at),
    activatedAt: r.activated_at ? new Date(r.activated_at) : null,
    endedAt: r.ended_at ? new Date(r.ended_at) : null,
    expiredAt: r.expired_at ? new Date(r.expired_at) : null,
    callCount: r.call_count,
    lastCallAt: r.last_call_at ? new Date(r.last_call_at) : null,
  };
}

export class SessionManager {
  private readonly redis = getRedis();
  private readonly pool = getNumberPool();

  async createSession(args: CreateSessionArgs): Promise<Session> {
    const {
      tenantId,
      agentPhone,
      customerPhone,
      metadata = {},
      gracePeriodMinutes = config.SESSION_DEFAULT_GRACE_PERIOD_MINUTES,
      maxDurationMinutes = config.SESSION_DEFAULT_MAX_DURATION_MINUTES,
      directionMode = 'BIDIRECTIONAL',
      recordingEnabled = false,
      consentPrompt = 'NONE',
      region,
    } = args;

    if (!tenantId) throw err('TENANT_REQUIRED', 400, 'tenantId is required');
    if (!E164_RE.test(agentPhone)) {
      throw err('INVALID_PHONE', 400, 'agentPhone must be valid E.164');
    }
    if (!E164_RE.test(customerPhone)) {
      throw err('INVALID_PHONE', 400, 'customerPhone must be valid E.164');
    }
    if (agentPhone === customerPhone) {
      throw err('SAME_PARTIES', 400, 'agentPhone and customerPhone must differ');
    }
    if (recordingEnabled && consentPrompt === 'NONE') {
      throw err(
        'CONSENT_REQUIRED',
        400,
        'recording_enabled requires consent_prompt of DEFAULT or CUSTOM (NDPR compliance)',
      );
    }

    const partyAHash = hashPhone(agentPhone, tenantId);
    const partyBHash = hashPhone(customerPhone, tenantId);
    const partyAEnc = encryptPhone(agentPhone, tenantId);
    const partyBEnc = encryptPhone(customerPhone, tenantId);
    const sessionId = randomUUID();

    // Allocate proxy from pool (atomic, overlap-checked)
    const proxy = await this.pool.allocate({
      region,
      partyAHash,
      partyBHash,
      sessionId,
    });

    if (!proxy) {
      sessionCreatedTotal.inc({ tenant_id: tenantId, status: 'failed' });
      throw err('POOL_EXHAUSTED', 503, 'No proxy numbers available for allocation');
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + maxDurationMinutes * 60_000);
    const db = getDb();

    try {
      // INSERT PENDING
      await db('sessions').insert({
        id: sessionId,
        tenant_id: tenantId,
        party_a_phone_enc: partyAEnc,
        party_b_phone_enc: partyBEnc,
        party_a_phone_hash: partyAHash,
        party_b_phone_hash: partyBHash,
        proxy_number: proxy,
        state: 'PENDING',
        direction_mode: directionMode,
        metadata: JSON.stringify(metadata),
        grace_period_min: gracePeriodMinutes,
        max_duration_min: maxDurationMinutes,
        recording_enabled: recordingEnabled,
        consent_prompt: consentPrompt,
        expires_at: expiresAt,
        created_at: now,
        call_count: 0,
      });

      // Transition to ACTIVE
      await db('sessions').where({ id: sessionId }).update({
        state: 'ACTIVE',
        activated_at: now,
      });

      // Write Redis session hash with TTL
      const ttlSec = maxDurationMinutes * 60;
      await this.redis.hset(`session:${sessionId}`, {
        id: sessionId,
        tenant_id: tenantId,
        party_a_hash: partyAHash,
        party_b_hash: partyBHash,
        proxy_number: proxy,
        state: 'ACTIVE',
        direction_mode: directionMode,
        grace_period_min: String(gracePeriodMinutes),
        max_duration_min: String(maxDurationMinutes),
        recording_enabled: recordingEnabled ? '1' : '0',
        consent_prompt: consentPrompt,
        expires_at: expiresAt.toISOString(),
        created_at: now.toISOString(),
        activated_at: now.toISOString(),
        call_count: '0',
      });
      await this.redis.expire(`session:${sessionId}`, ttlSec);

      // Track tenant's active sessions (used by TierEnforcer)
      await this.redis.sadd(`tenant:${tenantId}:active_sessions`, sessionId);

      sessionCreatedTotal.inc({ tenant_id: tenantId, status: 'success' });
      activeSessionsGauge.inc({ tenant_id: tenantId });

      logger.info(
        {
          sessionId,
          tenantId,
          proxy,
          directionMode,
          recordingEnabled,
        },
        'Session created',
      );

      const row = await db<DbSessionRow>('sessions').where({ id: sessionId }).first();
      if (!row) throw err('SESSION_NOT_FOUND', 500, 'Inserted session vanished');
      return rowToSession(row);
    } catch (e) {
      // Rollback allocation
      try {
        await this.pool.release({ proxyNumber: proxy, sessionId, region, cooldownMinutes: 0 });
      } catch (releaseErr) {
        logger.warn({ err: releaseErr, sessionId }, 'SessionManager: rollback release failed');
      }
      try {
        await db('sessions').where({ id: sessionId }).update({ state: 'FAILED' });
      } catch {
        /* ignore */
      }
      sessionCreatedTotal.inc({ tenant_id: tenantId, status: 'failed' });
      throw e;
    }
  }

  async getSession(id: string, tenantId: string): Promise<Session | null> {
    const db = getDb();
    const row = await db<DbSessionRow>('sessions').where({ id, tenant_id: tenantId }).first();
    return row ? rowToSession(row) : null;
  }

  async getSessionsByTenant(tenantId: string, opts: ListSessionsOptions = {}): Promise<Session[]> {
    const db = getDb();
    const limit = Math.min(opts.limit ?? 50, 200);
    const query = db<DbSessionRow>('sessions').where({ tenant_id: tenantId }).orderBy('created_at', 'desc').limit(limit);
    if (opts.state) query.andWhere({ state: opts.state });
    if (opts.after) {
      // cursor = ISO timestamp of last created_at
      query.andWhere('created_at', '<', new Date(opts.after));
    }
    const rows = await query;
    return rows.map(rowToSession);
  }

  async endSession(id: string, tenantId: string): Promise<Session | null> {
    const db = getDb();
    const session = await this.getSession(id, tenantId);
    if (!session) return null;
    if (session.state === 'EXPIRED' || session.state === 'GRACE_PERIOD') return session;

    const now = new Date();
    const graceMs = session.gracePeriodMin * 60_000;
    const newExpiry = new Date(now.getTime() + graceMs);

    await db('sessions').where({ id, tenant_id: tenantId }).update({
      state: 'GRACE_PERIOD',
      ended_at: now,
      expires_at: newExpiry,
    });

    await this.redis.hset(`session:${id}`, {
      state: 'GRACE_PERIOD',
      ended_at: now.toISOString(),
      expires_at: newExpiry.toISOString(),
    });
    // Update TTL on the Redis hash to match grace period
    if (graceMs > 0) {
      await this.redis.expire(`session:${id}`, Math.ceil(graceMs / 1000));
    }

    logger.info({ sessionId: id, tenantId, graceMinutes: session.gracePeriodMin }, 'Session entered grace period');

    return { ...session, state: 'GRACE_PERIOD', endedAt: now, expiresAt: newExpiry };
  }

  async expireSession(id: string): Promise<boolean> {
    const db = getDb();
    const row = await db<DbSessionRow>('sessions').where({ id }).first();
    if (!row) return false;
    if (row.state === 'EXPIRED') return true;

    const now = new Date();

    await db('sessions').where({ id }).update({
      state: 'EXPIRED',
      expired_at: now,
    });

    // Return proxy to pool with cooldown
    try {
      await this.pool.release({
        proxyNumber: row.proxy_number,
        sessionId: id,
        cooldownMinutes: config.POOL_COOLDOWN_MINUTES,
      });
    } catch (e) {
      logger.warn({ err: e, sessionId: id, proxy: row.proxy_number }, 'SessionManager: proxy release failed');
    }

    // Cleanup Redis
    try {
      await this.redis.del(`session:${id}`);
      await this.redis.srem(`proxy:${row.proxy_number}:sessions`, id);
      await this.redis.srem(`phone:${row.party_a_phone_hash}:sessions`, id);
      await this.redis.srem(`phone:${row.party_b_phone_hash}:sessions`, id);
      await this.redis.srem(`tenant:${row.tenant_id}:active_sessions`, id);
    } catch (e) {
      logger.warn({ err: e, sessionId: id }, 'SessionManager: redis cleanup failed');
    }

    activeSessionsGauge.dec({ tenant_id: row.tenant_id });

    logger.info({ sessionId: id, tenantId: row.tenant_id }, 'Session expired');
    return true;
  }

  /**
   * SDK call verification: returns true if there's an active session for this
   * user (hashed phone) AND a recent call event in the last 60s on its proxy.
   */
  async verifyCall(userPhoneHash: string, tenantId: string): Promise<{
    verified: boolean;
    sessionId?: string;
    proxyNumber?: string;
    metadata?: Record<string, unknown>;
  }> {
    try {
      const sessionIds = await this.redis.smembers(`phone:${userPhoneHash}:sessions`);
      if (!sessionIds.length) return { verified: false };

      const now = Date.now();
      for (const sid of sessionIds) {
        const s = await this.redis.hgetall(`session:${sid}`);
        if (!s || !s.id) continue;
        if (s.tenant_id !== tenantId) continue;
        if (s.state !== 'ACTIVE' && s.state !== 'GRACE_PERIOD') continue;

        const lastCallStr = s.last_call_at;
        if (!lastCallStr) continue;
        const lastCallMs = new Date(lastCallStr).getTime();
        if (Number.isNaN(lastCallMs)) continue;
        if (now - lastCallMs > 60_000) continue;

        return {
          verified: true,
          sessionId: sid,
          proxyNumber: s.proxy_number,
        };
      }
      return { verified: false };
    } catch (e) {
      logger.warn({ err: e, userPhoneHash, tenantId }, 'SessionManager.verifyCall failed');
      return { verified: false };
    }
  }
}

let instance: SessionManager | null = null;
export function getSessionManager(): SessionManager {
  if (!instance) instance = new SessionManager();
  return instance;
}
