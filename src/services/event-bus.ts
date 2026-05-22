import { getRedis, getRedisSub } from '../config/redis';
import { config } from '../config/env';
import { logger } from '../utils/logger';

export interface EventPayload {
  tenantId?: string;
  [k: string]: unknown;
}

export type EventHandler = (event: {
  id: string;
  type: string;
  payload: EventPayload;
}) => Promise<void> | void;

interface ConsumerInfo {
  eventType: string;
  group: string;
  consumer: string;
  handler: EventHandler;
  running: boolean;
}

const STREAM_PREFIX = 'events:';

/**
 * EventBus over Redis Streams (durable consumer-group semantics) plus a
 * Pub/Sub fan-out for WebSocket replicas. Streams give us at-least-once
 * delivery with replay; Pub/Sub gives us instant fan-out to WS clients.
 */
export class EventBus {
  private readonly redis = getRedis();
  private consumers = new Map<string, ConsumerInfo>();

  async publish(eventType: string, payload: EventPayload): Promise<string> {
    const streamKey = `${STREAM_PREFIX}${eventType}`;
    const body = JSON.stringify(payload);

    let id = '';
    try {
      id = (await this.redis.xadd(
        streamKey,
        'MAXLEN',
        '~',
        '10000',
        '*',
        'type',
        eventType,
        'payload',
        body,
        'ts',
        String(Date.now()),
      )) as string;
    } catch (e) {
      logger.error({ err: e, eventType }, 'EventBus: XADD failed');
    }

    // Pub/Sub fan-out: scope to tenant when provided
    if (payload.tenantId) {
      try {
        const channel = `${config.REDIS_PREFIX}tenant:${payload.tenantId}:events`;
        // Use main client for PUBLISH (subscriber connection cannot publish)
        await this.redis.publish(channel, JSON.stringify({ type: eventType, payload, id }));
      } catch (e) {
        logger.warn({ err: e, tenantId: payload.tenantId }, 'EventBus: pubsub publish failed');
      }
    }

    return id;
  }

  async subscribe(
    eventType: string,
    consumerGroup: string,
    consumerId: string,
    handler: EventHandler,
  ): Promise<void> {
    const streamKey = `${STREAM_PREFIX}${eventType}`;
    const key = `${eventType}::${consumerGroup}::${consumerId}`;

    if (this.consumers.has(key)) {
      logger.warn({ key }, 'EventBus: consumer already exists');
      return;
    }

    // Best-effort create group; MKSTREAM creates the stream if it doesn't exist.
    try {
      await this.redis.xgroup('CREATE', streamKey, consumerGroup, '$', 'MKSTREAM');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes('BUSYGROUP')) {
        logger.warn({ err: e, streamKey, group: consumerGroup }, 'EventBus: XGROUP CREATE failed');
      }
    }

    const info: ConsumerInfo = {
      eventType,
      group: consumerGroup,
      consumer: consumerId,
      handler,
      running: true,
    };
    this.consumers.set(key, info);

    // Spawn read loop (non-blocking)
    void this.readLoop(streamKey, info);
    logger.info({ streamKey, group: consumerGroup, consumer: consumerId }, 'EventBus: subscribed');
  }

  private async readLoop(streamKey: string, info: ConsumerInfo): Promise<void> {
    while (info.running) {
      try {
        const raw = (await this.redis.xreadgroup(
          'GROUP',
          info.group,
          info.consumer,
          'COUNT',
          10,
          'BLOCK',
          5000,
          'STREAMS',
          streamKey,
          '>',
        )) as Array<[string, Array<[string, string[]]>]> | null;

        if (!raw || !raw.length) continue;

        for (const [, entries] of raw) {
          for (const [entryId, fields] of entries) {
            const obj: Record<string, string> = {};
            for (let i = 0; i < fields.length; i += 2) {
              obj[fields[i]] = fields[i + 1];
            }
            try {
              const payload = obj.payload ? (JSON.parse(obj.payload) as EventPayload) : {};
              await info.handler({ id: entryId, type: obj.type ?? info.eventType, payload });
              await this.redis.xack(streamKey, info.group, entryId);
            } catch (handlerErr) {
              logger.error(
                { err: handlerErr, streamKey, entryId, group: info.group },
                'EventBus: handler failed — entry left for retry',
              );
              // Do NOT ack — entry remains as pending for retry / claim by another consumer
            }
          }
        }
      } catch (err) {
        if (!info.running) break;
        logger.error({ err, streamKey, group: info.group }, 'EventBus: read loop error');
        // brief backoff
        await new Promise((res) => setTimeout(res, 500));
      }
    }
    logger.info(
      { streamKey, group: info.group, consumer: info.consumer },
      'EventBus: consumer stopped',
    );
  }

  async close(): Promise<void> {
    for (const info of this.consumers.values()) {
      info.running = false;
    }
    this.consumers.clear();
  }
}

let instance: EventBus | null = null;
export function getEventBus(): EventBus {
  if (!instance) instance = new EventBus();
  return instance;
}

// re-export getRedisSub so consumers that want raw pubsub can wire it without
// reaching into config (keeps DI testable)
export { getRedisSub };
