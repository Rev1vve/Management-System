import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import type { ScryptOptions } from 'node:crypto';

import { Injectable } from '@nestjs/common';

/**
 * Password hashing built on Node's built-in scrypt (no native dependencies,
 * works in the slim runtime image without a build toolchain).
 *
 * Stored format: `scrypt$N$r$p$saltB64url$keyB64url`
 * - N, r, p are the scrypt cost parameters (self-describing so they can be
 *   raised in the future without breaking existing hashes).
 * - The salt and derived key are base64url encoded.
 * - Comparison uses timingSafeEqual; malformed or unknown-format strings
 *   fail closed (return false, never throw).
 */
@Injectable()
export class PasswordHashService {
  private static readonly MIN_PASSWORD_LENGTH = 8;

  // Memory-hard scrypt parameters tuned for a ~5-user internal system:
  // N=2^15, r=8, p=1 (OWASP guidance allows raising N later; parameters are
  // stored per-hash so future increases do not invalidate existing hashes).
  private static readonly N = 32768;
  private static readonly R = 8;
  private static readonly P = 1;
  private static readonly KEY_LENGTH = 64;
  private static readonly SALT_LENGTH = 24;
  // OpenSSL's default scrypt maxmem is 32 MiB; N=2^15,r=8 needs exactly 32 MiB
  // (128*N*r) and is rejected at the boundary. 128 MiB leaves headroom for
  // future parameter increases without hitting the limit.
  private static readonly MAXMEM = 128 * 1024 * 1024;

  async hash(password: string): Promise<string> {
    this.assertValidPassword(password);
    const salt = randomBytes(PasswordHashService.SALT_LENGTH);
    const key = await this.scrypt(password, salt, PasswordHashService.KEY_LENGTH, {
      N: PasswordHashService.N,
      r: PasswordHashService.R,
      p: PasswordHashService.P,
      maxmem: PasswordHashService.MAXMEM,
    });
    return [
      'scrypt',
      PasswordHashService.N,
      PasswordHashService.R,
      PasswordHashService.P,
      salt.toString('base64url'),
      key.toString('base64url'),
    ].join('$');
  }

  async verify(password: string, stored: string): Promise<boolean> {
    const parsed = this.parse(stored);
    if (!parsed) {
      return false;
    }
    const { n, r, p, salt, expectedKey } = parsed;
    try {
      const actualKey = await this.scrypt(password, salt, expectedKey.length, {
        N: n,
        r,
        p,
        maxmem: PasswordHashService.MAXMEM,
      });
      return actualKey.length === expectedKey.length && timingSafeEqual(actualKey, expectedKey);
    } catch {
      return false;
    }
  }

  private assertValidPassword(password: string): void {
    if (password === undefined || password === null) {
      throw new Error('Password is required');
    }
    if (password.trim().length < PasswordHashService.MIN_PASSWORD_LENGTH) {
      throw new Error(
        `Password must be at least ${PasswordHashService.MIN_PASSWORD_LENGTH} characters`,
      );
    }
  }

  private scrypt(
    password: string,
    salt: Buffer,
    keylen: number,
    options: ScryptOptions,
  ): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      scryptCallback(password, salt, keylen, options, (err, derivedKey) => {
        if (err) {
          reject(err);
        } else {
          resolve(derivedKey);
        }
      });
    });
  }

  private parse(stored: string): {
    n: number;
    r: number;
    p: number;
    salt: Buffer;
    expectedKey: Buffer;
  } | null {
    if (typeof stored !== 'string') {
      return null;
    }
    const [algorithm, nPart, rPart, pPart, saltPart, keyPart] = stored.split('$');
    if (
      algorithm !== 'scrypt' ||
      nPart === undefined ||
      rPart === undefined ||
      pPart === undefined ||
      saltPart === undefined ||
      keyPart === undefined
    ) {
      return null;
    }
    const n = Number(nPart);
    const r = Number(rPart);
    const p = Number(pPart);
    if (
      !Number.isInteger(n) ||
      !Number.isInteger(r) ||
      !Number.isInteger(p) ||
      n <= 0 ||
      r <= 0 ||
      p <= 0
    ) {
      return null;
    }
    let salt: Buffer;
    let expectedKey: Buffer;
    try {
      salt = Buffer.from(saltPart, 'base64url');
      expectedKey = Buffer.from(keyPart, 'base64url');
    } catch {
      return null;
    }
    if (salt.length === 0 || expectedKey.length === 0) {
      return null;
    }
    return { n, r, p, salt, expectedKey };
  }
}
