import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';

import { PrismaService } from '../../database/prisma.service';
import { PasswordHashService } from '../../crypto/password-hash.service';
import { sha256Hex } from '../../crypto/token.util';
import type { Session, User } from '../../generated/prisma/client';
import { SessionsService, SESSION_TTL_MS } from '../sessions/sessions.service';
import { MfaService } from '../mfa/mfa.service';
import { AuditService } from '../audit/audit.service';

export const MAX_FAILED_ATTEMPTS = 5;
export const LOCK_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
export const MAX_MFA_ATTEMPTS = 5;
export const MFA_LOCK_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

export interface LoginInput {
  accountOrEmail: string;
  password: string;
  deviceInfo?: string;
}

export interface LoginResult {
  token: string;
  session: Session;
  userId: string;
  mfaRequired: boolean;
  /** True when the account holds a privileged role (D-056) but has no TOTP
   * enabled yet: the session stays PENDING_MFA until MFA is set up. */
  mfaSetupRequired: boolean;
}

/**
 * Password login, DB-backed throttling and session lifecycle (task 5):
 * - Unknown accounts and wrong passwords return the same generic 401 to avoid
 *   account enumeration.
 * - Repeated failures (5) lock the account for 15 minutes; even a correct
 *   password is rejected while locked. A successful login resets the counter.
 * - Accounts that are not ACTIVE cannot log in or use existing sessions.
 * - When the account has TOTP enabled, login completes step one (password)
 *   and returns a PENDING_MFA session; step two (TOTP) is handled by the MFA
 *   module. The MFA challenge has its own failure counter and lockout so a
 *   compromised password alone cannot be used to brute-force the 6-digit code.
 *
 * Throttling state lives in the users table (survives restarts; no Redis).
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsService,
    private readonly passwordHash: PasswordHashService,
    private readonly mfa: MfaService,
    private readonly audit: AuditService,
  ) {}

  async login(input: LoginInput): Promise<LoginResult> {
    const accountOrEmail = input.accountOrEmail.trim().toLowerCase();
    const user = await this.prisma.user.findFirst({
      where: {
        OR: [{ account: accountOrEmail }, { workEmail: accountOrEmail }],
      },
      include: {
        systemRoles: { include: { systemRole: true } },
      },
    });
    if (!user) {
      await this.audit.record({
        actorId: null,
        action: 'auth.login',
        resourceType: 'user',
        result: 'FAILURE',
        summary: `登录失败：账号不存在 (${accountOrEmail})`,
      });
      throw new UnauthorizedException('账号或密码错误');
    }
    if (user.status !== 'ACTIVE') {
      if (user.status === 'INVITED') {
        throw new ForbiddenException('账号尚未激活，请先完成邀请激活');
      }
      if (user.status === 'SUSPENDED') {
        throw new ForbiddenException('账号已停用');
      }
      throw new ForbiddenException('账号不可用');
    }
    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      throw new ForbiddenException('账号已锁定，请稍后再试');
    }

    const passwordOk = await this.passwordHash.verify(input.password, user.passwordHash ?? '');
    if (!passwordOk) {
      // Atomic counter increment (avoids the read-modify-write race where two
      // concurrent failures could both read N-1 and write N).
      const updated = await this.prisma.user.update({
        where: { id: user.id },
        data: { failedLoginCount: { increment: 1 } },
        select: { failedLoginCount: true },
      });
      if (updated.failedLoginCount >= MAX_FAILED_ATTEMPTS) {
        await this.prisma.user.update({
          where: { id: user.id },
          data: { lockedUntil: new Date(Date.now() + LOCK_WINDOW_MS) },
        });
      }
      await this.audit.record({
        actorId: user.id,
        action: 'auth.login',
        resourceType: 'user',
        resourceId: user.id,
        result: 'FAILURE',
        summary: `登录失败：密码错误 (第 ${updated.failedLoginCount} 次)`,
      });
      throw new UnauthorizedException('账号或密码错误');
    }

    // Success: reset throttling state and record login time.
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginCount: 0,
        lockedUntil: null,
        lastLoginAt: new Date(),
      },
    });

    // D-056: privileged roles (approver, PM, director, executive, admin) must
    // enable TOTP. When such an account has no MFA yet, login reports
    // mfaSetupRequired and keeps the session PENDING_MFA until MFA is set up.
    const holdsPrivilegedRole = user.systemRoles.some((m) => m.systemRole.requiresMfa);
    const mfaSetupRequired = holdsPrivilegedRole && !user.mfaEnabled;
    const mfaRequired = user.mfaEnabled || mfaSetupRequired;

    const created = await this.sessions.create(user.id, {
      status: mfaRequired ? 'PENDING_MFA' : 'ACTIVE',
      ...(input.deviceInfo !== undefined ? { deviceInfo: input.deviceInfo } : {}),
    });
    await this.audit.record({
      actorId: user.id,
      action: 'auth.login',
      resourceType: 'user',
      resourceId: user.id,
      result: 'SUCCESS',
      summary: mfaRequired ? '登录成功（待 MFA 第二步）' : '登录成功',
    });
    return {
      token: created.token,
      session: created.session,
      userId: created.userId,
      mfaRequired,
      mfaSetupRequired,
    };
  }

  async me(token: string): Promise<User> {
    const { user } = await this.sessions.validate(token);
    return user;
  }

  /**
   * Step two of login for accounts with TOTP enabled: verifies the code and
   * upgrades the PENDING_MFA session to ACTIVE (extending its expiry). Fails
   * closed — a wrong code leaves the session pending and the user unverified.
   * Wrong codes count against a per-account MFA lockout (5 in 15 minutes).
   */
  async verifyMfaChallenge(token: string, code: string): Promise<{ user: User; session: Session }> {
    const session = await this.findPendingSession(token);
    await this.assertMfaNotLocked(session.userId);
    const verified = await this.mfa.verifyCode(session.userId, code);
    if (!verified) {
      await this.recordMfaFailure(session.userId);
      await this.audit.record({
        actorId: session.userId,
        action: 'auth.mfa_verify',
        resourceType: 'session',
        resourceId: session.id,
        result: 'FAILURE',
      });
      throw new UnauthorizedException('验证码不正确');
    }
    await this.resetMfaCounters(session.userId);
    const updated = await this.prisma.session.update({
      where: { id: session.id },
      data: {
        status: 'ACTIVE',
        expiresAt: new Date(Date.now() + SESSION_TTL_MS),
        lastUsedAt: new Date(),
      },
    });
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: session.userId },
    });
    await this.audit.record({
      actorId: user.id,
      action: 'auth.mfa_verify',
      resourceType: 'session',
      resourceId: session.id,
      result: 'SUCCESS',
    });
    return { user, session: updated };
  }

  /**
   * Alternative step two using a single-use recovery code (lost device).
   * Consumes the code and upgrades the session in one transaction so a
   * failed upgrade never burns a code. Subject to the same MFA lockout.
   */
  async verifyRecoveryChallenge(
    token: string,
    code: string,
  ): Promise<{ user: User; session: Session }> {
    const session = await this.findPendingSession(token);
    await this.assertMfaNotLocked(session.userId);

    const outcome = await this.prisma.$transaction(async (tx) => {
      const verified = await this.mfa.verifyRecoveryCode(session.userId, code, tx);
      if (!verified) {
        return null;
      }
      const updated = await tx.session.update({
        where: { id: session.id },
        data: {
          status: 'ACTIVE',
          expiresAt: new Date(Date.now() + SESSION_TTL_MS),
          lastUsedAt: new Date(),
        },
      });
      const user = await tx.user.findUniqueOrThrow({
        where: { id: session.userId },
      });
      return { user, session: updated };
    });

    if (!outcome) {
      await this.recordMfaFailure(session.userId);
      await this.audit.record({
        actorId: session.userId,
        action: 'auth.recovery_login',
        resourceType: 'session',
        resourceId: session.id,
        result: 'FAILURE',
      });
      throw new UnauthorizedException('恢复码无效或已使用');
    }
    await this.resetMfaCounters(session.userId);
    await this.audit.record({
      actorId: outcome.user.id,
      action: 'auth.recovery_login',
      resourceType: 'session',
      resourceId: session.id,
      result: 'SUCCESS',
    });
    return outcome;
  }

  async logout(token: string): Promise<void> {
    await this.prisma.session.updateMany({
      where: { tokenHash: sha256Hex(token), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  private async findPendingSession(token: string): Promise<Session> {
    const session = await this.prisma.session.findUnique({
      where: { tokenHash: sha256Hex(token) },
    });
    if (
      !session ||
      session.status !== 'PENDING_MFA' ||
      session.revokedAt !== null ||
      session.expiresAt.getTime() < Date.now()
    ) {
      throw new UnauthorizedException('会话无效或已过期');
    }
    const user = await this.prisma.user.findUnique({
      where: { id: session.userId },
    });
    if (!user || user.status !== 'ACTIVE') {
      throw new UnauthorizedException('账号不可用');
    }
    return session;
  }

  private async assertMfaNotLocked(userId: string): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { mfaLockedUntil: true },
    });
    if (user.mfaLockedUntil && user.mfaLockedUntil.getTime() > Date.now()) {
      throw new ForbiddenException('MFA 验证失败次数过多，请稍后再试');
    }
  }

  private async recordMfaFailure(userId: string): Promise<void> {
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { mfaFailedAttempts: { increment: 1 } },
      select: { mfaFailedAttempts: true },
    });
    if (updated.mfaFailedAttempts >= MAX_MFA_ATTEMPTS) {
      await this.prisma.user.update({
        where: { id: userId },
        data: { mfaLockedUntil: new Date(Date.now() + MFA_LOCK_WINDOW_MS) },
      });
    }
  }

  private async resetMfaCounters(userId: string): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { mfaFailedAttempts: 0, mfaLockedUntil: null },
    });
  }
}
