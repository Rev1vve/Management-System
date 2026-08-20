import { createHash, randomBytes } from 'node:crypto';

/**
 * Shared token primitives for invitations, sessions and recovery codes.
 *
 * - `randomToken` produces cryptographically random base64url tokens (no
 *   padding), suitable for one-time and session secrets that are only ever
 *   stored as their SHA-256 digest.
 * - `sha256Hex` digests a token for at-rest storage. Comparing digests (not
 *   raw tokens) keeps the plaintext secret out of the database.
 */
export function randomToken(bytes: number): string {
  if (!Number.isInteger(bytes) || bytes <= 0) {
    throw new Error('Token length must be a positive integer');
  }
  return randomBytes(bytes).toString('base64url');
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
