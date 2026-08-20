import { describe, expect, it } from 'vitest';

import { MfaCipherService } from './mfa-cipher.service';

describe('MfaCipherService', () => {
  // 32-byte hex key (test-only; real keys come from the environment secret).
  const key = 'a'.repeat(64);

  it('round-trips a TOTP secret', () => {
    const service = new MfaCipherService(key);
    const secret = 'JBSWY3DPEHPK3PXP';
    const encrypted = service.encrypt(secret);
    expect(encrypted).not.toContain(secret);
    expect(service.decrypt(encrypted)).toBe(secret);
  });

  it('produces a versioned, randomized ciphertext', () => {
    const service = new MfaCipherService(key);
    const a = service.encrypt('JBSWY3DPEHPK3PXP');
    const b = service.encrypt('JBSWY3DPEHPK3PXP');
    expect(a.startsWith('v1$')).toBe(true);
    // Fresh IV on every encryption.
    expect(a).not.toBe(b);
  });

  it('rejects tampered ciphertext', () => {
    const service = new MfaCipherService(key);
    const encrypted = service.encrypt('JBSWY3DPEHPK3PXP');
    const [version, iv, tag, data] = encrypted.split('$');
    // Flip the FIRST base64url character: its 6 bits always take part in the
    // decode (unlike the last character, whose low bits are ignored when the
    // encoded length is not a multiple of 4), so the plaintext is guaranteed
    // to change and the GCM auth tag must fail.
    const flipped =
      data !== undefined && data.startsWith('A')
        ? 'B' + data.slice(1)
        : 'A' + (data ?? '').slice(1);
    expect(() => service.decrypt([version, iv, tag, flipped].join('$'))).toThrow();
  });

  it('rejects unknown version or malformed payloads', () => {
    const service = new MfaCipherService(key);
    expect(() => service.decrypt('v9$aa$bb$cc')).toThrow();
    expect(() => service.decrypt('garbage')).toThrow();
  });

  it('fails closed when the key is missing or invalid', () => {
    expect(() => new MfaCipherService('')).toThrow(/key/i);
    expect(() => new MfaCipherService('too-short')).toThrow(/key/i);
  });
});
