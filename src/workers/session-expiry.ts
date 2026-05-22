import { getDb } from '../config/database';
import { config } from '../config/env';
import { logger } from '../utils/logger';
import type { SessionManager } from '../services/session-manager';

/**
 * SessionExpiryWorker
 *
 * Periodically scans the sessions table for rows whose state is ACTIVE or
 * GRACE_PERIOD and whose expires_at has elapsed. For each, asks SessionManager
 * to transition it to EXPIRED (which also releases the proxy back to the pool
 * with cooldown).
 *
 * The worker is single-instance friendly: an inFlight guard prevents overlapping
 * ticks if a tick happens to take longer than the configured interval. In
 * production, leader election (or a single replica deployment for the worker
 * service) prevents duplicate work across instances.
 */
export class SessionExpiryWorker {
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private readonly intervalMs: number;
  private readonly batchLimit = 100;

  constructor(private readonly sessionManager: SessionManager) {
    this.intervalMs = config.SESSION_EXPIRY_CHECK_INTERVAL_SECONDS * 1000;
  }

  start(): void {
    if (this.timer) return;
    logger.info({ intervalMs: this.intervalMs }, 'SessionExpiryWorker started');
    this.timer = setInterval(() => {
      // Fire-and-forget; tick() is fully self-contained.
      void this.tick();
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info('SessionExpiryWorker stopped');
    }
  }

  async tick(): Promise<void> {
    if (this.inFlight) {
      logger.debug('SessionExpiryWorker: tick still in flight, skipping');
      return;
    }
    this.inFlight = true;
    const startedAt = Date.now();

    try {
      const db = getDb();
      const rows = await db('sessions')
        .select('id')
        .whereIn('state', ['ACTIVE', 'GRACE_PERIOD'])
        .andWhere('expires_at', '<', new Date())
        .limit(this.batchLimit);

      if (rows.length === 0) {
        return;
      }

      logger.info({ count: rows.length }, 'SessionExpiryWorker: expiring sessions');

      let succeeded = 0;
      let failed = 0;
      for (const row of rows) {
        try {
          const ok = await this.sessionManager.expireSession(row.id);
          if (ok) succeeded++;
          else failed++;
        } catch (err) {
          failed++;
          logger.warn({ err, sessionId: row.id }, 'SessionExpiryWorker: expire failed');
        }
      }

      logger.info(
        { succeeded, failed, durationMs: Date.now() - startedAt },
        'SessionExpiryWorker: tick complete',
      );
    } catch (err) {
      // Never let an error crash the worker.
      logger.error({ err }, 'SessionExpiryWorker: tick error');
    } finally {
      this.inFlight = false;
    }
  }
}
