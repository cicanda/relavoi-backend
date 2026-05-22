import { randomUUID } from 'crypto';
import { getRedis } from '../config/redis';
import { getDb } from '../config/database';
import { logger } from '../utils/logger';
import { hashPhone } from '../utils/crypto';
import { callRoutingDuration, callRoutingTotal } from '../utils/metrics';
import { decryptPhone } from '../utils/crypto';

const DEFAULT_CONSENT_AUDIO_URL =
  'https://cdn.relavoi.com/audio/consent_default_en.mp3';
const DEDUP_TTL_SEC = 60;

export type RouteAction =
  | 'forward'
  | 'consent_then_forward'
  | 'dead_line'
  | 'redirect'
  | 'play_message';

export interface RouteIncomingCallArgs {
  proxyNumber: string;
  callerPhone: string; // E.164
  tenantHint?: string;
  eventId: string;
}

export interface RouteDecision {
  action: RouteAction;
  destination?: string;
  callerId?: string;
  audioUrl?: string;
  message?: string;
  sessionId?: string;
  callRecordId?: string;
  tenantId?: string;
}

interface RedisSessionHash {
  id?: string;
  tenant_id?: string;
  party_a_hash?: string;
  party_b_hash?: string;
  proxy_number?: string;
  state?: string;
  direction_mode?: string;
  recording_enabled?: string;
  consent_prompt?: string;
}

interface TenantRoutingConfig {
  expired_call_behavior: 'DEAD_LINE' | 'REDIRECT_SUPPORT' | 'PLAY_MESSAGE';
  support_phone: string | null;
  recording_consent_audio_url: string | null;
  expired_message_audio_url?: string | null;
}

export class CallRouter {
  private readonly redis = getRedis();

  async routeIncomingCall(args: RouteIncomingCallArgs): Promise<RouteDecision> {
    const start = process.hrtime.bigint();
    const stop = (result: string): void => {
      const elapsedSec = Number(process.hrtime.bigint() - start) / 1e9;
      callRoutingDuration.observe(elapsedSec);
      callRoutingTotal.inc({ result });
    };

    // Dedup cache hit?
    try {
      const cached = await this.redis.get(`webhook:dedup:${args.eventId}`);
      if (cached) {
        const decision = JSON.parse(cached) as RouteDecision;
        stop('cached');
        return decision;
      }
    } catch (e) {
      logger.warn({ err: e, eventId: args.eventId }, 'CallRouter: dedup lookup failed');
    }

    // Find candidate sessions on this proxy
    let sessionIds: string[] = [];
    try {
      sessionIds = await this.redis.smembers(`proxy:${args.proxyNumber}:sessions`);
    } catch (e) {
      logger.error({ err: e, proxy: args.proxyNumber }, 'CallRouter: proxy session lookup failed');
    }

    let matched: { session: RedisSessionHash; callerIsA: boolean } | null = null;

    for (const sid of sessionIds) {
      let s: RedisSessionHash;
      try {
        s = (await this.redis.hgetall(`session:${sid}`)) as RedisSessionHash;
      } catch {
        continue;
      }
      if (!s || !s.id) continue;
      if (s.state !== 'ACTIVE' && s.state !== 'GRACE_PERIOD') continue;
      if (args.tenantHint && s.tenant_id !== args.tenantHint) continue;
      if (!s.tenant_id) continue;

      const callerHash = hashPhone(args.callerPhone, s.tenant_id);
      if (callerHash === s.party_a_hash) {
        matched = { session: s, callerIsA: true };
        break;
      }
      if (callerHash === s.party_b_hash) {
        matched = { session: s, callerIsA: false };
        break;
      }
    }

    if (!matched) {
      // No active session — apply tenant default behavior if we can resolve tenant
      const tenantId =
        args.tenantHint ?? (await this.resolveTenantForProxy(args.proxyNumber)) ?? undefined;
      const decision = await this.buildNoSessionDecision(tenantId);
      await this.cacheDecision(args.eventId, decision);
      stop('no_session');
      return decision;
    }

    const session = matched.session;
    const tenantId = session.tenant_id as string;

    // Direction mode enforcement
    const direction = (session.direction_mode ?? 'BIDIRECTIONAL') as
      | 'BIDIRECTIONAL'
      | 'A_TO_B_ONLY'
      | 'B_TO_A_ONLY';
    if (direction === 'A_TO_B_ONLY' && !matched.callerIsA) {
      const decision: RouteDecision = {
        action: 'dead_line',
        message: 'This number is not authorized to call this destination',
        tenantId,
      };
      await this.cacheDecision(args.eventId, decision);
      stop('direction_violation');
      return decision;
    }
    if (direction === 'B_TO_A_ONLY' && matched.callerIsA) {
      const decision: RouteDecision = {
        action: 'dead_line',
        message: 'This number is not authorized to call this destination',
        tenantId,
      };
      await this.cacheDecision(args.eventId, decision);
      stop('direction_violation');
      return decision;
    }

    // Resolve destination phone by decrypting the OTHER party
    let destination: string | undefined;
    try {
      const enc = await this.getEncryptedPhoneFromDb(
        session.id as string,
        matched.callerIsA ? 'party_b_phone_enc' : 'party_a_phone_enc',
      );
      if (enc) {
        destination = decryptPhone(enc, tenantId);
      }
    } catch (e) {
      logger.error({ err: e, sessionId: session.id }, 'CallRouter: failed to resolve destination');
    }

    if (!destination) {
      const decision: RouteDecision = { action: 'dead_line', message: 'Destination unavailable', tenantId };
      await this.cacheDecision(args.eventId, decision);
      stop('failed');
      return decision;
    }

    const recordingEnabled = session.recording_enabled === '1' || session.recording_enabled === 'true';
    const consentPrompt = (session.consent_prompt ?? 'NONE') as 'DEFAULT' | 'CUSTOM' | 'NONE';

    let audioUrl: string | undefined;
    let action: RouteAction = 'forward';
    if (recordingEnabled) {
      if (consentPrompt === 'NONE') {
        // Data invariant violated; fail safe
        logger.error(
          { sessionId: session.id },
          'CallRouter: recording_enabled with NONE consent — data invariant violated',
        );
        const decision: RouteDecision = { action: 'dead_line', message: 'Configuration error', tenantId };
        await this.cacheDecision(args.eventId, decision);
        stop('failed');
        return decision;
      }

      action = 'consent_then_forward';
      if (consentPrompt === 'DEFAULT') {
        audioUrl = DEFAULT_CONSENT_AUDIO_URL;
      } else if (consentPrompt === 'CUSTOM') {
        const cfg = await this.getTenantConfig(tenantId);
        audioUrl = cfg?.recording_consent_audio_url ?? DEFAULT_CONSENT_AUDIO_URL;
      }
    }

    const callRecordId = randomUUID();
    const decision: RouteDecision = {
      action,
      destination,
      callerId: args.proxyNumber,
      audioUrl,
      sessionId: session.id,
      callRecordId,
      tenantId,
    };

    // Cache decision for dedup
    await this.cacheDecision(args.eventId, decision);

    // Async DB writes — do NOT await (keep hot path fast)
    void this.writeCallRecord({
      callRecordId,
      sessionId: session.id as string,
      direction: matched.callerIsA ? 'A_TO_B' : 'B_TO_A',
      cpaasCallId: args.eventId,
      recordingConsentPlayed: action === 'consent_then_forward',
    });
    void this.bumpSessionCallCount(session.id as string);

    stop('routed');
    return decision;
  }

  private async cacheDecision(eventId: string, decision: RouteDecision): Promise<void> {
    try {
      await this.redis.set(
        `webhook:dedup:${eventId}`,
        JSON.stringify(decision),
        'EX',
        DEDUP_TTL_SEC,
      );
    } catch (e) {
      logger.warn({ err: e, eventId }, 'CallRouter: dedup cache write failed');
    }
  }

  private async buildNoSessionDecision(tenantId?: string): Promise<RouteDecision> {
    if (!tenantId) {
      return { action: 'dead_line', message: 'This number is no longer in service' };
    }
    const cfg = await this.getTenantConfig(tenantId);
    if (!cfg) {
      return { action: 'dead_line', message: 'This number is no longer in service', tenantId };
    }
    if (cfg.expired_call_behavior === 'REDIRECT_SUPPORT' && cfg.support_phone) {
      return {
        action: 'redirect',
        destination: cfg.support_phone,
        tenantId,
      };
    }
    if (cfg.expired_call_behavior === 'PLAY_MESSAGE' && cfg.expired_message_audio_url) {
      return {
        action: 'play_message',
        audioUrl: cfg.expired_message_audio_url,
        tenantId,
      };
    }
    return {
      action: 'dead_line',
      message: 'This number is no longer in service',
      tenantId,
    };
  }

  private async resolveTenantForProxy(proxy: string): Promise<string | null> {
    // Best-effort: the most recent session on this proxy in DB tells us tenant.
    try {
      const db = getDb();
      const row = await db('sessions')
        .where({ proxy_number: proxy })
        .orderBy('created_at', 'desc')
        .first('tenant_id');
      return row?.tenant_id ?? null;
    } catch {
      return null;
    }
  }

  private async getEncryptedPhoneFromDb(
    sessionId: string,
    column: 'party_a_phone_enc' | 'party_b_phone_enc',
  ): Promise<Buffer | null> {
    try {
      const db = getDb();
      const row = await db('sessions').where({ id: sessionId }).first(column);
      const buf = row?.[column];
      if (!buf) return null;
      return Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    } catch (e) {
      logger.error({ err: e, sessionId }, 'CallRouter: db phone lookup failed');
      return null;
    }
  }

  private async getTenantConfig(tenantId: string): Promise<TenantRoutingConfig | null> {
    try {
      const db = getDb();
      const row = await db('tenants')
        .where({ id: tenantId })
        .first(
          'expired_call_behavior',
          'support_phone',
          'recording_consent_audio_url',
          'push_config',
        );
      if (!row) return null;
      const expMsgFromPush =
        typeof row.push_config === 'object' && row.push_config
          ? (row.push_config.expired_message_audio_url as string | undefined)
          : undefined;
      return {
        expired_call_behavior: row.expired_call_behavior ?? 'DEAD_LINE',
        support_phone: row.support_phone ?? null,
        recording_consent_audio_url: row.recording_consent_audio_url ?? null,
        expired_message_audio_url: expMsgFromPush ?? null,
      };
    } catch (e) {
      logger.warn({ err: e, tenantId }, 'CallRouter: tenant config lookup failed');
      return null;
    }
  }

  private async writeCallRecord(args: {
    callRecordId: string;
    sessionId: string;
    direction: 'A_TO_B' | 'B_TO_A';
    cpaasCallId: string;
    recordingConsentPlayed: boolean;
  }): Promise<void> {
    try {
      const db = getDb();
      await db('call_records').insert({
        id: args.callRecordId,
        session_id: args.sessionId,
        cpaas_call_id: args.cpaasCallId,
        cpaas_provider: 'AFRICASTALKING',
        direction: args.direction,
        status: 'RINGING',
        recording_consent_played: args.recordingConsentPlayed,
        initiated_at: new Date(),
      });
    } catch (e) {
      logger.warn({ err: e, ...args }, 'CallRouter: call_record insert failed');
    }
  }

  private async bumpSessionCallCount(sessionId: string): Promise<void> {
    const now = new Date();
    try {
      await this.redis.hset(`session:${sessionId}`, 'last_call_at', now.toISOString());
      await this.redis.hincrby(`session:${sessionId}`, 'call_count', 1);
    } catch (e) {
      logger.warn({ err: e, sessionId }, 'CallRouter: redis call bump failed');
    }
    try {
      const db = getDb();
      await db('sessions')
        .where({ id: sessionId })
        .update({ last_call_at: now })
        .increment('call_count', 1);
    } catch (e) {
      logger.warn({ err: e, sessionId }, 'CallRouter: db call bump failed');
    }
  }
}

let instance: CallRouter | null = null;
export function getCallRouter(): CallRouter {
  if (!instance) instance = new CallRouter();
  return instance;
}
