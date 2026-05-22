import { randomUUID } from 'crypto';
import { getDb } from '../config/database';
import { logger } from '../utils/logger';

export type DevicePlatform = 'ios' | 'android';

export interface RegisterTokenArgs {
  tenantId: string;
  userPhoneHash: string;
  token: string;
  platform: DevicePlatform;
  appBundleId?: string;
}

export interface DeviceToken {
  id: string;
  tenantId: string;
  userPhoneHash: string;
  token: string;
  platform: DevicePlatform;
  appBundleId?: string;
  isActive: boolean;
  lastRefreshedAt: Date;
  createdAt: Date;
}

interface DbDeviceTokenRow {
  id: string;
  tenant_id: string;
  user_phone_hash: string;
  token: string;
  platform: DevicePlatform;
  app_bundle_id?: string | null;
  is_active: boolean;
  last_refreshed_at: Date | string;
  created_at: Date | string;
}

function rowToDeviceToken(r: DbDeviceTokenRow): DeviceToken {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    userPhoneHash: r.user_phone_hash,
    token: r.token,
    platform: r.platform,
    appBundleId: r.app_bundle_id ?? undefined,
    isActive: r.is_active,
    lastRefreshedAt: new Date(r.last_refreshed_at),
    createdAt: new Date(r.created_at),
  };
}

export class DeviceTokenManager {
  async register(args: RegisterTokenArgs): Promise<DeviceToken> {
    if (!args.token || !args.token.length) {
      throw new Error('register: token required');
    }
    const db = getDb();
    const now = new Date();
    const id = randomUUID();

    // UPSERT on conflict(token): merge refreshed_at + is_active=true
    const inserted = await db('device_tokens')
      .insert({
        id,
        tenant_id: args.tenantId,
        user_phone_hash: args.userPhoneHash,
        token: args.token,
        platform: args.platform,
        app_bundle_id: args.appBundleId ?? null,
        is_active: true,
        last_refreshed_at: now,
        created_at: now,
      })
      .onConflict('token')
      .merge({
        tenant_id: args.tenantId,
        user_phone_hash: args.userPhoneHash,
        platform: args.platform,
        app_bundle_id: args.appBundleId ?? null,
        is_active: true,
        last_refreshed_at: now,
      })
      .returning('*');

    const row = (inserted[0] ?? null) as DbDeviceTokenRow | null;
    if (!row) {
      const found = await db<DbDeviceTokenRow>('device_tokens')
        .where({ token: args.token })
        .first();
      if (!found) throw new Error('register: insert/upsert returned no row');
      return rowToDeviceToken(found);
    }
    return rowToDeviceToken(row);
  }

  async getTokensForUser(tenantId: string, userPhoneHash: string): Promise<DeviceToken[]> {
    const db = getDb();
    const rows = await db<DbDeviceTokenRow>('device_tokens')
      .where({ tenant_id: tenantId, user_phone_hash: userPhoneHash, is_active: true })
      .orderBy('last_refreshed_at', 'desc');
    return rows.map(rowToDeviceToken);
  }

  async deactivateToken(token: string): Promise<boolean> {
    const db = getDb();
    const updated = await db('device_tokens').where({ token }).update({ is_active: false });
    return updated > 0;
  }

  async cleanupStaleTokens(staleDays: number = 30): Promise<number> {
    const db = getDb();
    const cutoff = new Date(Date.now() - staleDays * 24 * 60 * 60 * 1000);
    try {
      const updated = await db('device_tokens')
        .where('last_refreshed_at', '<', cutoff)
        .andWhere({ is_active: true })
        .update({ is_active: false });
      logger.info({ staleDays, deactivated: updated }, 'DeviceTokenManager: stale cleanup');
      return updated;
    } catch (err) {
      logger.error({ err }, 'DeviceTokenManager: cleanup failed');
      return 0;
    }
  }
}

let instance: DeviceTokenManager | null = null;
export function getDeviceTokenManager(): DeviceTokenManager {
  if (!instance) instance = new DeviceTokenManager();
  return instance;
}
