import { describe, it, expect } from 'vitest';
import { encryptPhone, decryptPhone, hashPhone } from '../../src/utils/crypto';

const TENANT_A = '00000000-0000-0000-0000-000000000001';
const TENANT_B = '00000000-0000-0000-0000-000000000002';
const PHONE = '+2348012345678';

describe('crypto utils', () => {
  describe('encrypt/decrypt round-trip', () => {
    it('decrypts back to the same plaintext for the same tenant', () => {
      const enc = encryptPhone(PHONE, TENANT_A);
      const dec = decryptPhone(enc, TENANT_A);
      expect(dec).toBe(PHONE);
    });

    it('produces a different ciphertext each call (random IV)', () => {
      const a = encryptPhone(PHONE, TENANT_A);
      const b = encryptPhone(PHONE, TENANT_A);
      expect(a.equals(b)).toBe(false);
    });

    it('cannot decrypt across tenants', () => {
      const enc = encryptPhone(PHONE, TENANT_A);
      expect(() => decryptPhone(enc, TENANT_B)).toThrow();
    });

    it('decryption fails on tampered ciphertext', () => {
      const enc = encryptPhone(PHONE, TENANT_A);
      // Flip a byte in the ciphertext region (after iv+tag = 28 bytes)
      enc[enc.length - 1] ^= 0x01;
      expect(() => decryptPhone(enc, TENANT_A)).toThrow();
    });

    it('rejects buffers that are too short', () => {
      expect(() => decryptPhone(Buffer.from('short'), TENANT_A)).toThrow();
    });
  });

  describe('hashPhone', () => {
    it('is deterministic for the same (phone, tenant)', () => {
      const a = hashPhone(PHONE, TENANT_A);
      const b = hashPhone(PHONE, TENANT_A);
      expect(a).toBe(b);
    });

    it('produces different hashes across tenants for the same phone', () => {
      const a = hashPhone(PHONE, TENANT_A);
      const b = hashPhone(PHONE, TENANT_B);
      expect(a).not.toBe(b);
    });

    it('produces different hashes for different phones in the same tenant', () => {
      const a = hashPhone(PHONE, TENANT_A);
      const b = hashPhone('+2348087654321', TENANT_A);
      expect(a).not.toBe(b);
    });

    it('returns a 64-char hex string', () => {
      const h = hashPhone(PHONE, TENANT_A);
      expect(h).toMatch(/^[0-9a-f]{64}$/);
    });
  });
});
