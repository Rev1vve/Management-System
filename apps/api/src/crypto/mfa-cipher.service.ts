import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const VERSION = 'v1';

/**
 * Encrypts the TOTP secret at rest with AES-256-GCM.
 *
 * - The key is a 64-character hex string (32 bytes) read from the
 *   `MFA_SECRET_KEY` environment variable; the service fails closed at
 *   construction if it is missing or invalid.
 * - Ciphertext format: `v1$<ivB64url>$<authTagB64url>$<dataB64url>`.
 * - A fresh random IV is used per encryption, so equal plaintexts produce
 *   different ciphertexts; the auth tag detects tampering.
 * - The plaintext secret is never logged and never stored.
 */
@Injectable()
export class MfaCipherService {
  private readonly key: Buffer;

  constructor(key: string) {
    const trimmed = key.trim();
    if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) {
      throw new Error('MFA_SECRET_KEY must be a 64-character hex string (32 bytes)');
    }
    this.key = Buffer.from(trimmed, 'hex');
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      VERSION,
      iv.toString('base64url'),
      tag.toString('base64url'),
      data.toString('base64url'),
    ].join('$');
  }

  decrypt(payload: string): string {
    const parts = payload.split('$');
    if (parts.length !== 4 || parts[0] !== VERSION) {
      throw new Error('Unsupported or malformed MFA secret payload');
    }
    const [, ivB64, tagB64, dataB64] = parts;
    if (!ivB64 || !tagB64 || !dataB64) {
      throw new Error('Malformed MFA secret payload');
    }
    const iv = Buffer.from(ivB64, 'base64url');
    const tag = Buffer.from(tagB64, 'base64url');
    const data = Buffer.from(dataB64, 'base64url');
    if (iv.length !== IV_LENGTH || tag.length !== AUTH_TAG_LENGTH) {
      throw new Error('Malformed MFA secret payload');
    }
    const decipher = createDecipheriv(ALGORITHM, this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  }
}
