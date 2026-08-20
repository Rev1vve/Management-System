import { describe, expect, it } from 'vitest';

import { PasswordHashService } from './password-hash.service';

describe('PasswordHashService', () => {
  const service = new PasswordHashService();

  describe('hash', () => {
    it('produces a versioned scrypt string with six fields', async () => {
      const stored = await service.hash('correct horse battery staple');
      const parts = stored.split('$');
      expect(parts).toHaveLength(6);
      expect(parts[0]).toBe('scrypt');
      // N, r, p parameters are positive integers.
      expect(Number(parts[1]!)).toBeGreaterThan(0);
      expect(Number(parts[2]!)).toBeGreaterThan(0);
      expect(Number(parts[3]!)).toBeGreaterThan(0);
      // Salt (24 bytes) and derived key (64 bytes) are non-empty base64url.
      expect(parts[4]!).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(parts[4]!.length).toBeGreaterThanOrEqual(32);
      expect(parts[5]!).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(parts[5]!.length).toBeGreaterThanOrEqual(64);
    });

    it('uses a fresh random salt on every hash', async () => {
      const a = await service.hash('same password');
      const b = await service.hash('same password');
      expect(a).not.toBe(b);
    });

    it('rejects passwords shorter than the minimum length', async () => {
      await expect(service.hash('short')).rejects.toThrow(/at least 8/i);
    });

    it('rejects empty or whitespace-only passwords', async () => {
      await expect(service.hash('')).rejects.toThrow(/at least 8/i);
      await expect(service.hash('       ')).rejects.toThrow(/at least 8/i);
    });
  });

  describe('verify', () => {
    it('accepts the correct password', async () => {
      const stored = await service.hash('correct horse battery staple');
      await expect(service.verify('correct horse battery staple', stored)).resolves.toBe(true);
    });

    it('rejects a wrong password', async () => {
      const stored = await service.hash('correct horse battery staple');
      await expect(service.verify('wrong password', stored)).resolves.toBe(false);
    });

    it('rejects a near-miss password', async () => {
      const stored = await service.hash('correct horse battery staple');
      await expect(service.verify('correct horse battery staple!', stored)).resolves.toBe(false);
    });

    it('returns false for a malformed stored hash', async () => {
      await expect(service.verify('whatever', 'not-a-valid-format')).resolves.toBe(false);
      await expect(service.verify('whatever', 'scrypt$1$1')).resolves.toBe(false);
    });

    it('returns false for an unknown algorithm prefix', async () => {
      await expect(service.verify('whatever', 'bcrypt$12$saltsalt$hashhash')).resolves.toBe(false);
    });
  });
});
