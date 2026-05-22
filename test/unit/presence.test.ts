/**
 * Presence-manager tests against a real Redis instance.
 *
 * This is a "unit" test that talks to the local Redis container (the same one
 * the dev stack uses) under a unique key prefix to avoid clobbering app data.
 * Skips itself gracefully if Redis isn't reachable.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PresenceManager } from '../../src/services/presence-manager';
import { getRedis, disconnectRedis } from '../../src/config/redis';

const TENANT = 'tenant-presence-test';
const HASH_A = 'hash-a-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HASH_B = 'hash-b-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

describe('PresenceManager (real Redis)', () => {
  let pm: PresenceManager;
  let redisAvailable = false;

  beforeAll(async () => {
    try {
      await getRedis().ping();
      redisAvailable = true;
    } catch {
      redisAvailable = false;
    }
    pm = new PresenceManager();
  });

  beforeEach(async () => {
    if (!redisAvailable) return;
    // ioredis doesn't auto-apply keyPrefix to SCAN MATCH patterns, so sweep
    // by explicit keys (DEL does honor keyPrefix).
    const redis = getRedis();
    await redis.del(`presence:${TENANT}:${HASH_A}`, `presence:${TENANT}:${HASH_B}`);
  });

  afterAll(async () => {
    if (!redisAvailable) return;
    const redis = getRedis();
    await redis.del(`presence:${TENANT}:${HASH_A}`, `presence:${TENANT}:${HASH_B}`);
    await disconnectRedis();
  });

  it.runIf(true)('updatePresence: sets key with online status', async () => {
    if (!redisAvailable) return;
    await pm.updatePresence({ tenantId: TENANT, userPhoneHash: HASH_A, status: 'online', platform: 'ios' });
    const state = await pm.getPresence(TENANT, HASH_A);
    expect(state.status).toBe('online');
    expect(state.platform).toBe('ios');
    expect(state.ts).toBeGreaterThan(0);
  });

  it('updatePresence with background is reachable', async () => {
    if (!redisAvailable) return;
    await pm.updatePresence({ tenantId: TENANT, userPhoneHash: HASH_A, status: 'background', platform: 'android' });
    const state = await pm.getPresence(TENANT, HASH_A);
    expect(state.status).toBe('background');
    expect(await pm.isReachable(TENANT, HASH_A)).toBe(true);
  });

  it('updatePresence with offline DELETES the key (no stale ts)', async () => {
    if (!redisAvailable) return;
    await pm.updatePresence({ tenantId: TENANT, userPhoneHash: HASH_A, status: 'online' });
    await pm.updatePresence({ tenantId: TENANT, userPhoneHash: HASH_A, status: 'offline' });
    const redis = getRedis();
    const raw = await redis.get(`presence:${TENANT}:${HASH_A}`);
    expect(raw).toBeNull();
    const state = await pm.getPresence(TENANT, HASH_A);
    expect(state.status).toBe('offline');
  });

  it('getPresence returns offline when key missing', async () => {
    if (!redisAvailable) return;
    const state = await pm.getPresence(TENANT, HASH_B);
    expect(state.status).toBe('offline');
    expect(state.ts).toBe(0);
  });

  it('isReachable: true when online or background, false otherwise', async () => {
    if (!redisAvailable) return;
    await pm.updatePresence({ tenantId: TENANT, userPhoneHash: HASH_A, status: 'online' });
    expect(await pm.isReachable(TENANT, HASH_A)).toBe(true);

    await pm.updatePresence({ tenantId: TENANT, userPhoneHash: HASH_A, status: 'offline' });
    expect(await pm.isReachable(TENANT, HASH_A)).toBe(false);

    expect(await pm.isReachable(TENANT, HASH_B)).toBe(false);
  });

  it('key has a TTL roughly equal to 120s', async () => {
    if (!redisAvailable) return;
    await pm.updatePresence({ tenantId: TENANT, userPhoneHash: HASH_A, status: 'online' });
    const redis = getRedis();
    const ttl = await redis.ttl(`presence:${TENANT}:${HASH_A}`);
    expect(ttl).toBeGreaterThan(100);
    expect(ttl).toBeLessThanOrEqual(120);
  });

  it('updatePresence is idempotent (same status applied twice)', async () => {
    if (!redisAvailable) return;
    await pm.updatePresence({ tenantId: TENANT, userPhoneHash: HASH_A, status: 'online' });
    await pm.updatePresence({ tenantId: TENANT, userPhoneHash: HASH_A, status: 'online' });
    const state = await pm.getPresence(TENANT, HASH_A);
    expect(state.status).toBe('online');
  });

  it('different users do not collide', async () => {
    if (!redisAvailable) return;
    await pm.updatePresence({ tenantId: TENANT, userPhoneHash: HASH_A, status: 'online' });
    await pm.updatePresence({ tenantId: TENANT, userPhoneHash: HASH_B, status: 'background' });
    const a = await pm.getPresence(TENANT, HASH_A);
    const b = await pm.getPresence(TENANT, HASH_B);
    expect(a.status).toBe('online');
    expect(b.status).toBe('background');
  });
});
