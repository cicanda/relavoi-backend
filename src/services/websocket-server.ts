import type { FastifyInstance, FastifyRequest } from 'fastify';
import { getRedisSub } from '../config/redis';
import { config } from '../config/env';
import { logger } from '../utils/logger';

interface WSConnection {
  socket: import('ws').WebSocket;
  tenantId: string;
  userId?: string;
  alive: boolean;
  heartbeatTimer?: NodeJS.Timeout;
}

interface JwtPayload {
  tenantId?: string;
  tenant_id?: string;
  sub?: string;
  type?: string;
  [k: string]: unknown;
}

/**
 * Reference-counted Redis Pub/Sub subscription manager. Multiple WS clients
 * for the same tenant share one subscription; when the last one drops, we
 * unsubscribe to keep the subscriber connection lean.
 */
class TenantSubscriptionManager {
  private tenantConnections = new Map<string, Set<WSConnection>>();
  private subscribed = new Set<string>();

  async add(tenantId: string, conn: WSConnection): Promise<void> {
    let set = this.tenantConnections.get(tenantId);
    if (!set) {
      set = new Set();
      this.tenantConnections.set(tenantId, set);
    }
    set.add(conn);

    if (!this.subscribed.has(tenantId)) {
      const channel = `${config.REDIS_PREFIX}tenant:${tenantId}:events`;
      try {
        await getRedisSub().subscribe(channel);
        this.subscribed.add(tenantId);
        logger.debug({ tenantId, channel }, 'WS: subscribed to redis channel');
      } catch (err) {
        logger.error({ err, tenantId }, 'WS: redis subscribe failed');
      }
    }
  }

  async remove(tenantId: string, conn: WSConnection): Promise<void> {
    const set = this.tenantConnections.get(tenantId);
    if (!set) return;
    set.delete(conn);
    if (set.size === 0) {
      this.tenantConnections.delete(tenantId);
      const channel = `${config.REDIS_PREFIX}tenant:${tenantId}:events`;
      try {
        await getRedisSub().unsubscribe(channel);
        this.subscribed.delete(tenantId);
        logger.debug({ tenantId, channel }, 'WS: unsubscribed from redis channel');
      } catch (err) {
        logger.warn({ err, tenantId }, 'WS: redis unsubscribe failed');
      }
    }
  }

  fanout(channel: string, message: string): void {
    // channel comes back without prefix-stripping → derive tenantId.
    const expectedPrefix = `${config.REDIS_PREFIX}tenant:`;
    if (!channel.startsWith(expectedPrefix)) return;
    const rest = channel.slice(expectedPrefix.length);
    const tenantId = rest.split(':')[0];
    const set = this.tenantConnections.get(tenantId);
    if (!set) return;
    for (const conn of set) {
      if (!conn.alive) continue;
      try {
        conn.socket.send(message);
      } catch (err) {
        logger.warn({ err, tenantId }, 'WS: send failed');
      }
    }
  }
}

const subMgr = new TenantSubscriptionManager();
let pubsubInitialized = false;

function initPubsubBridge(): void {
  if (pubsubInitialized) return;
  pubsubInitialized = true;
  const sub = getRedisSub();
  sub.on('message', (channel: string, message: string) => {
    subMgr.fanout(channel, message);
  });
}

interface WsContext {
  socket: import('ws').WebSocket;
}

export function setupWebSocketServer(app: FastifyInstance): void {
  initPubsubBridge();

  app.get('/ws', { websocket: true }, (raw: unknown, request: FastifyRequest) => {
    const ctx = raw as WsContext;
    const socket = ctx.socket;
    const tokenQs = (request.query as { token?: string } | undefined)?.token;
    if (!tokenQs) {
      socket.close(4001, 'token required');
      return;
    }

    let decoded: JwtPayload;
    try {
      // @fastify/jwt decorates app with .jwt
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      decoded = (app as any).jwt.verify(tokenQs) as JwtPayload;
    } catch (err) {
      logger.warn({ err }, 'WS: invalid jwt');
      socket.close(4003, 'invalid token');
      return;
    }

    const tenantId = decoded.tenantId ?? decoded.tenant_id;
    if (!tenantId) {
      socket.close(4003, 'token missing tenant');
      return;
    }

    const conn: WSConnection = {
      socket,
      tenantId,
      userId: decoded.sub,
      alive: true,
    };

    // Heartbeat
    socket.on('pong', () => {
      conn.alive = true;
    });
    conn.heartbeatTimer = setInterval(() => {
      if (!conn.alive) {
        try {
          socket.terminate();
        } catch {
          /* ignore */
        }
        return;
      }
      conn.alive = false;
      try {
        socket.ping();
      } catch {
        /* ignore */
      }
    }, 30_000);

    void subMgr.add(tenantId, conn);

    socket.on('message', (raw: Buffer | string) => {
      // Echo / ping replies — clients can send "ping" to keep alive
      const txt = raw.toString();
      if (txt === 'ping') {
        try {
          socket.send('pong');
        } catch {
          /* ignore */
        }
      }
    });

    const cleanup = (): void => {
      if (conn.heartbeatTimer) clearInterval(conn.heartbeatTimer);
      conn.alive = false;
      void subMgr.remove(tenantId, conn);
    };

    socket.on('close', cleanup);
    socket.on('error', (err: Error) => {
      logger.warn({ err, tenantId }, 'WS: socket error');
      cleanup();
    });

    // Welcome
    try {
      socket.send(JSON.stringify({ type: 'connected', tenantId, at: Date.now() }));
    } catch {
      /* ignore */
    }
  });
}
