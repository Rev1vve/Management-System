import { Injectable, UnauthorizedException } from '@nestjs/common';

import { PrismaService } from '../../database/prisma.service';
import { randomToken, sha256Hex } from '../../crypto/token.util';
import type { Session, User } from '../../generated/prisma/client';

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const PENDING_MFA_TTL_MS = 5 * 60 * 1000; // 5 minutes

export interface CreatedSession {
  token: string;
  session: Session;
  userId: string;
}

export interface ValidatedSession {
  user: User;
  session: Session;
}

/**
 * Server-side sessions (plan section 20, task 5):
 * - Only the SHA-256 digest of the session token is stored; the raw token is
 *   returned once (to the Set-Cookie header) and never persisted or logged.
 * - A session starts PENDING_MFA when the account has TOTP enabled and only
 *   becomes ACTIVE after the TOTP challenge succeeds.
 * - Validation fails closed: unknown, expired, revoked or pending-MFA
 *   sessions are all treated as invalid.
 */
@Injectable()
export class SessionsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    userId: string,
    opts: { status?: 'PENDING_MFA' | 'ACTIVE'; deviceInfo?: string } = {},
  ): Promise<CreatedSession> {
    const status = opts.status ?? 'ACTIVE';
    const token = randomToken(32);
    const ttl = status === 'PENDING_MFA' ? PENDING_MFA_TTL_MS : SESSION_TTL_MS;
    const session = await this.prisma.session.create({
      data: {
        userId,
        tokenHash: sha256Hex(token),
        status,
        deviceInfo: opts.deviceInfo ?? null,
        lastUsedAt: new Date(),
        expiresAt: new Date(Date.now() + ttl),
      },
    });
    return { token, session, userId };
  }

  async validate(
    token: string,
    opts: { allowPendingMfa?: boolean } = {},
  ): Promise<ValidatedSession> {
    const session = await this.prisma.session.findUnique({
      where: { tokenHash: sha256Hex(token) },
      include: { user: true },
    });
    if (!session) {
      throw this.invalid();
    }
    const pendingAllowed = opts.allowPendingMfa === true;
    if (session.status !== 'ACTIVE' && !(pendingAllowed && session.status === 'PENDING_MFA')) {
      throw this.invalid();
    }
    if (session.revokedAt !== null) {
      throw this.invalid();
    }
    if (session.expiresAt.getTime() < Date.now()) {
      throw this.invalid();
    }
    if (session.user.status !== 'ACTIVE') {
      // Suspended/archived accounts cannot use their sessions.
      throw this.invalid();
    }

    // Touch last-used (best effort; a write failure must not break the request).
    await this.prisma.session
      .update({
        where: { id: session.id },
        data: { lastUsedAt: new Date() },
      })
      .catch(() => undefined);

    return { user: session.user, session };
  }

  /**
   * Upgrades a PENDING_MFA session to ACTIVE after the MFA challenge (or the
   * enrollment enable step) succeeds, extending its expiry to the full TTL.
   */
  async activatePending(token: string): Promise<Session> {
    return this.prisma.session.update({
      where: { tokenHash: sha256Hex(token) },
      data: {
        status: 'ACTIVE',
        expiresAt: new Date(Date.now() + SESSION_TTL_MS),
        lastUsedAt: new Date(),
      },
    });
  }

  async revokeById(userId: string, sessionId: string): Promise<void> {
    await this.prisma.session.updateMany({
      where: { id: sessionId, userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async revokeAll(userId: string): Promise<void> {
    await this.prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** Active (non-revoked, non-expired) sessions for the current user. */
  async listActive(userId: string): Promise<Session[]> {
    return this.prisma.session.findMany({
      where: {
        userId,
        status: 'ACTIVE',
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { lastUsedAt: 'desc' },
    });
  }

  private invalid(): Error {
    return new UnauthorizedException('会话无效或已过期');
  }
}
