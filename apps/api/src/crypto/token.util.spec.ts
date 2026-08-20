import { describe, expect, it } from 'vitest';

import { randomToken, sha256Hex } from './token.util';

describe('token.util', () => {
  describe('randomToken', () => {
    it('produces a base64url string of the requested byte length', () => {
      const token = randomToken(32);
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
      // base64url: ceil(bytes / 3) * 4 with no padding chars.
      expect(token.length).toBeGreaterThanOrEqual(32);
    });

    it('produces unique tokens on every call', () => {
      const a = randomToken(32);
      const b = randomToken(32);
      expect(a).not.toBe(b);
    });

    it('rejects non-positive lengths', () => {
      expect(() => randomToken(0)).toThrow(/positive/i);
    });
  });

  describe('sha256Hex', () => {
    it('is deterministic for the same input', () => {
      expect(sha256Hex('abc')).toBe(sha256Hex('abc'));
    });

    it('produces a 64-character lowercase hex digest', () => {
      expect(sha256Hex('abc')).toMatch(/^[0-9a-f]{64}$/);
    });

    it('differs for different inputs', () => {
      expect(sha256Hex('abc')).not.toBe(sha256Hex('abd'));
    });
  });
});
