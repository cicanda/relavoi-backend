import { randomUUID } from 'crypto';
import { getDb } from '../config/database';
import { logger } from '../utils/logger';

export type AuditActor = 'operator' | 'tenant' | 'system';

export interface AuditEntry {
  actorType: AuditActor;
  actorId: string; // required: schema column is NOT NULL
  action: string;
  resourceType: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
  ip?: string;
}

export class AuditLogger {
  /**
   * Fire-and-forget audit log write. Failures are logged at warn level and
   * swallowed — we should never break a business operation because the audit
   * sink is down.
   */
  async log(entry: AuditEntry): Promise<void> {
    try {
      const db = getDb();
      await db('audit_log').insert({
        id: randomUUID(),
        actor_type: entry.actorType,
        actor_id: entry.actorId,
        action: entry.action,
        resource_type: entry.resourceType,
        resource_id: entry.resourceId ?? null,
        details: entry.metadata ? JSON.stringify(entry.metadata) : '{}',
        ip_address: entry.ip ?? null,
        created_at: new Date(),
      });
    } catch (err) {
      logger.warn({ err, entry }, 'AuditLogger.log failed (swallowed)');
    }
  }
}

let instance: AuditLogger | null = null;
export function getAuditLogger(): AuditLogger {
  if (!instance) instance = new AuditLogger();
  return instance;
}
