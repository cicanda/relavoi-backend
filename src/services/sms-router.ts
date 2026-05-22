import { randomUUID } from 'crypto';
import { getRedis } from '../config/redis';
import { getDb } from '../config/database';
import { logger } from '../utils/logger';
import { decryptPhone, encryptPhone, hashPhone } from '../utils/crypto';
import { sendSms } from './africastalking/sms-sender';

const DEDUP_TTL_SEC = 60;

export type SmsAction = 'forward' | 'drop';

export interface RouteIncomingSmsArgs {
  proxyNumber: string;
  fromPhone: string;
  body: string;
  eventId: string;
  tenantHint?: string;
}

export interface SmsRouteDecision {
  action: SmsAction;
  destination?: string;
  body?: string;
  sessionId?: string;
  smsRecordId?: string;
  tenantId?: string;
  reason?: string;
}

export class SmsRouter {
  private readonly redis = getRedis();

  async routeIncomingSms(args: RouteIncomingSmsArgs): Promise<SmsRouteDecision> {
    // Dedup cache
    try {
      const cached = await this.redis.get(`webhook:dedup:${args.eventId}`);
      if (cached) {
        return JSON.parse(cached) as SmsRouteDecision;
      }
    } catch (e) {
      logger.warn({ err: e, eventId: args.eventId }, 'SmsRouter: dedup lookup failed');
    }

    let sessionIds: string[] = [];
    try {
      sessionIds = await this.redis.smembers(`proxy:${args.proxyNumber}:sessions`);
    } catch (e) {
      logger.error({ err: e, proxy: args.proxyNumber }, 'SmsRouter: proxy lookup failed');
    }

    let matched: {
      sessionId: string;
      tenantId: string;
      callerIsA: boolean;
      directionMode: 'BIDIRECTIONAL' | 'A_TO_B_ONLY' | 'B_TO_A_ONLY';
      partyAEnc?: Buffer;
      partyBEnc?: Buffer;
    } | null = null;

    for (const sid of sessionIds) {
      const s = await this.redis.hgetall(`session:${sid}`);
      if (!s || !s.id) continue;
      if (s.state !== 'ACTIVE' && s.state !== 'GRACE_PERIOD') continue;
      if (args.tenantHint && s.tenant_id !== args.tenantHint) continue;
      if (!s.tenant_id) continue;

      const fromHash = hashPhone(args.fromPhone, s.tenant_id);
      if (fromHash === s.party_a_hash) {
        matched = {
          sessionId: sid,
          tenantId: s.tenant_id,
          callerIsA: true,
          directionMode: (s.direction_mode ?? 'BIDIRECTIONAL') as
            | 'BIDIRECTIONAL'
            | 'A_TO_B_ONLY'
            | 'B_TO_A_ONLY',
        };
        break;
      }
      if (fromHash === s.party_b_hash) {
        matched = {
          sessionId: sid,
          tenantId: s.tenant_id,
          callerIsA: false,
          directionMode: (s.direction_mode ?? 'BIDIRECTIONAL') as
            | 'BIDIRECTIONAL'
            | 'A_TO_B_ONLY'
            | 'B_TO_A_ONLY',
        };
        break;
      }
    }

    if (!matched) {
      const decision: SmsRouteDecision = { action: 'drop', reason: 'no_session' };
      await this.cache(args.eventId, decision);
      return decision;
    }

    // Enforce direction mode (A_TO_B_ONLY → reject B-side senders, vice versa)
    if (
      (matched.directionMode === 'A_TO_B_ONLY' && !matched.callerIsA) ||
      (matched.directionMode === 'B_TO_A_ONLY' && matched.callerIsA)
    ) {
      const decision: SmsRouteDecision = {
        action: 'drop',
        reason: 'direction_mode_rejected',
        sessionId: matched.sessionId,
        tenantId: matched.tenantId,
      };
      await this.cache(args.eventId, decision);
      return decision;
    }

    // Resolve destination by decrypting the OTHER party
    let destination: string | undefined;
    try {
      const db = getDb();
      const row = await db('sessions')
        .where({ id: matched.sessionId })
        .first('party_a_phone_enc', 'party_b_phone_enc');
      if (row) {
        const buf = matched.callerIsA ? row.party_b_phone_enc : row.party_a_phone_enc;
        if (buf) {
          destination = decryptPhone(Buffer.isBuffer(buf) ? buf : Buffer.from(buf), matched.tenantId);
        }
      }
    } catch (e) {
      logger.error({ err: e, sessionId: matched.sessionId }, 'SmsRouter: decrypt failed');
    }

    if (!destination) {
      const decision: SmsRouteDecision = {
        action: 'drop',
        reason: 'destination_unavailable',
        sessionId: matched.sessionId,
        tenantId: matched.tenantId,
      };
      await this.cache(args.eventId, decision);
      return decision;
    }

    const smsRecordId = randomUUID();
    const decision: SmsRouteDecision = {
      action: 'forward',
      destination,
      body: args.body,
      sessionId: matched.sessionId,
      smsRecordId,
      tenantId: matched.tenantId,
    };
    await this.cache(args.eventId, decision);

    // Persist record (await so DB is consistent before forwarding side effects)
    try {
      const db = getDb();
      // Encrypt body with the tenant-scoped key — encryptPhone works for any
      // utf-8 string (it's AES-256-GCM keyed off the tenantId-derived secret).
      const messageTextEnc = encryptPhone(args.body, matched.tenantId);
      await db('sms_records').insert({
        id: smsRecordId,
        session_id: matched.sessionId,
        direction: matched.callerIsA ? 'A_TO_B' : 'B_TO_A',
        message_text_enc: messageTextEnc,
        status: 'PENDING',
        sent_at: new Date(),
      });
    } catch (e) {
      logger.warn({ err: e, smsRecordId }, 'SmsRouter: sms_records insert failed');
    }

    // Forward via AT (fire-and-forget so webhook returns fast, but record status)
    void this.forward(smsRecordId, args.proxyNumber, destination, args.body);

    return decision;
  }

  private async forward(
    smsRecordId: string,
    from: string,
    to: string,
    body: string,
  ): Promise<void> {
    const result = await sendSms({ from, to, message: body });
    try {
      const db = getDb();
      await db('sms_records')
        .where({ id: smsRecordId })
        .update({
          status: result.status === 'sent' ? 'DELIVERED' : 'FAILED',
          cpaas_message_id: result.messageId ?? null,
          delivered_at: result.status === 'sent' ? new Date() : null,
        });
    } catch (e) {
      logger.warn({ err: e, smsRecordId }, 'SmsRouter: sms_records update failed');
    }
  }

  private async cache(eventId: string, decision: SmsRouteDecision): Promise<void> {
    try {
      await this.redis.set(
        `webhook:dedup:${eventId}`,
        JSON.stringify(decision),
        'EX',
        DEDUP_TTL_SEC,
      );
    } catch (e) {
      logger.warn({ err: e, eventId }, 'SmsRouter: dedup cache write failed');
    }
  }
}

let instance: SmsRouter | null = null;
export function getSmsRouter(): SmsRouter {
  if (!instance) instance = new SmsRouter();
  return instance;
}
