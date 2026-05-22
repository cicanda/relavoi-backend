import { getRedis } from '../config/redis';
import { logger } from '../utils/logger';

export type PresenceStatus = 'online' | 'background' | 'offline';
export type DevicePlatform = 'ios' | 'android' | 'web';

export interface UpdatePresenceArgs {
  tenantId: string;
  userPhoneHash: string;
  status: PresenceStatus;
  platform?: DevicePlatform;
}

export interface PresenceState {
  status: PresenceStatus;
  platform?: DevicePlatform;
  ts: number;
}

const PRESENCE_TTL_SEC = 120;

export class PresenceManager {
  private readonly redis = getRedis();

  async updatePresence(args: UpdatePresenceArgs): Promise<void> {
    const key = `presence:${args.tenantId}:${args.userPhoneHash}`;
    try {
      if (args.status === 'offline') {
        await this.redis.del(key);
        return;
      }
      const payload: PresenceState = {
        status: args.status,
        platform: args.platform,
        ts: Date.now(),
      };
      await this.redis.set(key, JSON.stringify(payload), 'EX', PRESENCE_TTL_SEC);
    } catch (err) {
      logger.warn({ err, tenantId: args.tenantId }, 'PresenceManager: update failed');
    }
  }

  async getPresence(tenantId: string, userPhoneHash: string): Promise<PresenceState> {
    const key = `presence:${tenantId}:${userPhoneHash}`;
    try {
      const raw = await this.redis.get(key);
      if (!raw) return { status: 'offline', ts: 0 };
      try {
        const parsed = JSON.parse(raw) as PresenceState;
        return parsed;
      } catch {
        return { status: 'offline', ts: 0 };
      }
    } catch (err) {
      logger.warn({ err, tenantId }, 'PresenceManager: get failed');
      return { status: 'offline', ts: 0 };
    }
  }

  async isReachable(tenantId: string, userPhoneHash: string): Promise<boolean> {
    const p = await this.getPresence(tenantId, userPhoneHash);
    return p.status === 'online' || p.status === 'background';
  }
}

let instance: PresenceManager | null = null;
export function getPresenceManager(): PresenceManager {
  if (!instance) instance = new PresenceManager();
  return instance;
}
