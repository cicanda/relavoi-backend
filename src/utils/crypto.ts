import crypto from 'crypto';
import { config } from '../config/env';

const ALGO = 'aes-256-gcm';
const KEY_LEN = 32; // 256 bits
const IV_LEN = 12;  // GCM standard
const TAG_LEN = 16;
const PBKDF2_ITER = 100_000;

/**
 * Derive a tenant-scoped 256-bit key from the master key + tenantId.
 * PBKDF2-SHA256, 100k iterations.
 */
export function deriveKey(tenantId: string): Buffer {
  return crypto.pbkdf2Sync(
    config.ENCRYPTION_MASTER_KEY,
    tenantId,
    PBKDF2_ITER,
    KEY_LEN,
    'sha256',
  );
}

/**
 * Encrypt a phone number with AES-256-GCM scoped to a tenant.
 * Returns a single Buffer: [12-byte IV | 16-byte authTag | ciphertext].
 */
export function encryptPhone(phone: string, tenantId: string): Buffer {
  const key = deriveKey(tenantId);
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(phone, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]);
}

/**
 * Decrypt a buffer produced by encryptPhone for the same tenant.
 */
export function decryptPhone(buf: Buffer, tenantId: string): string {
  if (buf.length < IV_LEN + TAG_LEN + 1) {
    throw new Error('decryptPhone: input buffer too short');
  }
  const key = deriveKey(tenantId);
  const iv = buf.subarray(0, IV_LEN);
  const authTag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/**
 * Tenant-scoped phone hash for indexing/lookups. HMAC-SHA256 with tenantId as the key.
 * Returns lowercase hex (64 chars).
 */
export function hashPhone(phone: string, tenantId: string): string {
  return crypto.createHmac('sha256', tenantId).update(phone).digest('hex');
}
