import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { generateSync } from 'otplib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PrismaService } from '../../src/database/prisma.service';
import { PasswordHashService } from '../../src/crypto/password-hash.service';
import { MfaCipherService } from '../../src/crypto/mfa-cipher.service';
import { AuthService } from '../../src/modules/auth/auth.service';
import { SessionsService } from '../../src/modules/sessions/sessions.service';
import { MfaService } from '../../src/modules/mfa/mfa.service';
import { AuditService } from '../../src/modules/audit/audit.service';

/**
 * Integration tests for password login, DB-backed throttling, session
 * validation, /me, revocation and account suspension. Requires a real
 * PostgreSQL on the private Compose network.
 */
const prisma = new PrismaService();

const TABLES = [
  'audit_logs',
  'notifications',
  'email_outbox',
  'mfa_recovery_codes',
  'sessions',
  'invitations',
  'user_system_roles',
  'system_roles',
  'users',
];

async function truncateAll(): Promise<void> {
  const joined = TABLES.map((t) => `"${t}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${joined} RESTART IDENTITY CASCADE`);
}

const passwordHash = new PasswordHashService();
let sessionsService: SessionsService;
let authService: AuthService;

beforeAll(async () => {
  sessionsService = new SessionsService(prisma);
  authService = new AuthService(
    prisma,
    sessionsService,
    passwordHash,
    new MfaService(prisma, passwordHash, new MfaCipherService('c'.repeat(64))),
    new AuditService(prisma),
  );
});

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function createActiveUser(
  overrides: Partial<{
    account: string;
    workEmail: string;
    status: string;
    mfaEnabled: boolean;
  }> = {},
): Promise<{ id: string; account: string; password: string }> {
  const password = 'correct horse battery staple';
  const account = overrides.account ?? 'user1';
  await prisma.user.create({
    data: {
      account,
      name: '测试用户',
      workEmail: overrides.workEmail ?? `${account}@example.test`,
      status: (overrides.status ?? 'ACTIVE') as 'ACTIVE',
      mfaEnabled: overrides.mfaEnabled ?? false,
      passwordHash: await passwordHash.hash(password),
    },
  });
  return { id: '', account, password };
}

describe('AuthService / SessionsService', () => {
  it('logs in with correct credentials and creates an active session', async () => {
    await createActiveUser();
    const result = await authService.login({
      accountOrEmail: 'user1',
      password: 'correct horse battery staple',
    });

    expect(result.mfaRequired).toBe(false);
    expect(result.session.status).toBe('ACTIVE');

    const me = await authService.me(result.token);
    expect(me.account).toBe('user1');
    expect(me.status).toBe('ACTIVE');
  });

  it('logs in by work email as well', async () => {
    await createActiveUser();
    const result = await authService.login({
      accountOrEmail: 'user1@example.test',
      password: 'correct horse battery staple',
    });
    expect(result.session.status).toBe('ACTIVE');
  });

  it('rejects a wrong password with a generic message', async () => {
    await createActiveUser();
    await expect(
      authService.login({
        accountOrEmail: 'user1',
        password: 'wrong password here',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects an unknown account with the same generic message', async () => {
    await expect(
      authService.login({
        accountOrEmail: 'ghost',
        password: 'correct horse battery staple',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('locks the account after repeated failures and rejects even correct passwords during the window', async () => {
    const { account, password } = await createActiveUser();
    for (let i = 0; i < 5; i += 1) {
      await expect(
        authService.login({ accountOrEmail: account, password: 'nope nope nope' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    }
    // The 6th attempt — even with the correct password — is rejected while locked.
    await expect(authService.login({ accountOrEmail: account, password })).rejects.toBeInstanceOf(
      ForbiddenException,
    );

    const stored = await prisma.user.findUniqueOrThrow({ where: { account } });
    expect(stored.lockedUntil).not.toBeNull();
    expect(stored.failedLoginCount).toBe(5);
  });

  it('resets the failure counter after a successful login', async () => {
    const { account, password } = await createActiveUser();
    await expect(
      authService.login({ accountOrEmail: account, password: 'wrong wrong' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    await authService.login({ accountOrEmail: account, password });
    const stored = await prisma.user.findUniqueOrThrow({ where: { account } });
    expect(stored.failedLoginCount).toBe(0);
    expect(stored.lockedUntil).toBeNull();
  });

  it('recovers from a lock once the window has passed', async () => {
    const { account, password } = await createActiveUser();
    for (let i = 0; i < 5; i += 1) {
      await expect(
        authService.login({ accountOrEmail: account, password: 'bad' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    }
    // Move the lock into the past.
    await prisma.user.update({
      where: { account },
      data: { lockedUntil: new Date(Date.now() - 60_000) },
    });
    const result = await authService.login({ accountOrEmail: account, password });
    expect(result.session.status).toBe('ACTIVE');
  });

  it('requires a pending-MFA session step when the user has TOTP enabled', async () => {
    await createActiveUser({ mfaEnabled: true });
    const result = await authService.login({
      accountOrEmail: 'user1',
      password: 'correct horse battery staple',
    });
    expect(result.mfaRequired).toBe(true);
    expect(result.mfaSetupRequired).toBe(false);
    expect(result.session.status).toBe('PENDING_MFA');
    // /me must still refuse while the session is pending MFA.
    await expect(authService.me(result.token)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('forces MFA setup for a privileged role with TOTP not yet enabled (D-056)', async () => {
    const { account, password } = await createActiveUser();
    const role = await prisma.systemRole.upsert({
      where: { key: 'APPROVER' },
      update: {},
      create: { key: 'APPROVER', name: '审批人', requiresMfa: true },
    });
    const user = await prisma.user.findUniqueOrThrow({ where: { account } });
    await prisma.userSystemRole.create({
      data: { userId: user.id, systemRoleId: role.id },
    });

    const result = await authService.login({ accountOrEmail: account, password });
    expect(result.mfaRequired).toBe(true);
    expect(result.mfaSetupRequired).toBe(true);
    expect(result.session.status).toBe('PENDING_MFA');
    await expect(authService.me(result.token)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('does not force MFA for an employee-only account without TOTP', async () => {
    const { account, password } = await createActiveUser();
    const role = await prisma.systemRole.upsert({
      where: { key: 'EMPLOYEE' },
      update: {},
      create: { key: 'EMPLOYEE', name: '普通员工', requiresMfa: false },
    });
    const user = await prisma.user.findUniqueOrThrow({ where: { account } });
    await prisma.userSystemRole.create({
      data: { userId: user.id, systemRoleId: role.id },
    });

    const result = await authService.login({ accountOrEmail: account, password });
    expect(result.mfaRequired).toBe(false);
    expect(result.mfaSetupRequired).toBe(false);
    expect(result.session.status).toBe('ACTIVE');
  });

  it('completes step two with a valid TOTP code, upgrading the session to ACTIVE', async () => {
    await createActiveUser();
    const login = await authService.login({
      accountOrEmail: 'user1',
      password: 'correct horse battery staple',
    });
    expect(login.session.status).toBe('ACTIVE');

    // Enable MFA on the account (enroll refuses already-enabled accounts).
    const mfaService = new MfaService(prisma, passwordHash, new MfaCipherService('c'.repeat(64)));
    const { secret } = await mfaService.enroll(login.userId);
    await mfaService.enable(login.userId, generateSync({ secret }));

    // Next login is a two-step login.
    const stepOne = await authService.login({
      accountOrEmail: 'user1',
      password: 'correct horse battery staple',
    });
    expect(stepOne.mfaRequired).toBe(true);
    expect(stepOne.session.status).toBe('PENDING_MFA');

    const completed = await authService.verifyMfaChallenge(stepOne.token, generateSync({ secret }));
    expect(completed.session.status).toBe('ACTIVE');

    // /me now succeeds.
    const me = await authService.me(stepOne.token);
    expect(me.account).toBe('user1');
  });

  it('rejects step two with a wrong TOTP code and keeps the session pending', async () => {
    await createActiveUser({ mfaEnabled: true });
    const login = await authService.login({
      accountOrEmail: 'user1',
      password: 'correct horse battery staple',
    });
    await expect(authService.verifyMfaChallenge(login.token, '000000')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(authService.me(login.token)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('completes step two with a recovery code exactly once', async () => {
    await createActiveUser();
    const mfaService = new MfaService(prisma, passwordHash, new MfaCipherService('c'.repeat(64)));
    // Enable MFA on the account through the service, then log in.
    const user = await prisma.user.findUniqueOrThrow({ where: { account: 'user1' } });
    const enrollment = await mfaService.enroll(user.id);
    const { recoveryCodes } = await mfaService.enable(
      user.id,
      generateSync({ secret: enrollment.secret }),
    );

    const login = await authService.login({
      accountOrEmail: 'user1',
      password: 'correct horse battery staple',
    });
    expect(login.mfaRequired).toBe(true);

    const first = await authService.verifyRecoveryChallenge(login.token, recoveryCodes[0]!);
    expect(first.session.status).toBe('ACTIVE');

    // A second session can no longer use the same consumed code.
    const secondLogin = await authService.login({
      accountOrEmail: 'user1',
      password: 'correct horse battery staple',
    });
    await expect(
      authService.verifyRecoveryChallenge(secondLogin.token, recoveryCodes[0]!),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('locks the MFA challenge after repeated wrong codes and recovers after the window', async () => {
    await createActiveUser();
    const mfaService = new MfaService(prisma, passwordHash, new MfaCipherService('c'.repeat(64)));
    const user = await prisma.user.findUniqueOrThrow({ where: { account: 'user1' } });
    const enrollment = await mfaService.enroll(user.id);
    const { secret } = enrollment;
    // The challenge only exists once the account has MFA enabled.
    await mfaService.enable(user.id, generateSync({ secret }));

    const stepOne = await authService.login({
      accountOrEmail: 'user1',
      password: 'correct horse battery staple',
    });
    expect(stepOne.session.status).toBe('PENDING_MFA');

    // Five wrong codes lock the MFA challenge.
    for (let i = 0; i < 5; i += 1) {
      await expect(authService.verifyMfaChallenge(stepOne.token, '000000')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    }
    const locked = await prisma.user.findUniqueOrThrow({ where: { account: 'user1' } });
    expect(locked.mfaLockedUntil).not.toBeNull();
    expect(locked.mfaFailedAttempts).toBe(5);

    // Even a correct code is rejected while the challenge is locked.
    await expect(
      authService.verifyMfaChallenge(stepOne.token, generateSync({ secret })),
    ).rejects.toBeInstanceOf(ForbiddenException);

    // Moving the lock into the past unlocks the challenge.
    await prisma.user.update({
      where: { account: 'user1' },
      data: { mfaLockedUntil: new Date(Date.now() - 60_000) },
    });
    await expect(
      authService.verifyMfaChallenge(stepOne.token, generateSync({ secret })),
    ).resolves.toMatchObject({ session: { status: 'ACTIVE' } });
    const reset = await prisma.user.findUniqueOrThrow({ where: { account: 'user1' } });
    expect(reset.mfaFailedAttempts).toBe(0);
    expect(reset.mfaLockedUntil).toBeNull();
  });

  it('rejects an invalid or unknown session token', async () => {
    await createActiveUser();
    await expect(authService.me('no-such-token')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects an expired session', async () => {
    await createActiveUser();
    const { token, session } = await authService.login({
      accountOrEmail: 'user1',
      password: 'correct horse battery staple',
    });
    await prisma.session.update({
      where: { id: session.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    await expect(authService.me(token)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('revokes a single session by id', async () => {
    await createActiveUser();
    const { token, session, userId } = await authService.login({
      accountOrEmail: 'user1',
      password: 'correct horse battery staple',
    });
    await sessionsService.revokeById(userId, session.id);
    await expect(authService.me(token)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('revokes all sessions for a user', async () => {
    await createActiveUser();
    const first = await authService.login({
      accountOrEmail: 'user1',
      password: 'correct horse battery staple',
    });
    const second = await authService.login({
      accountOrEmail: 'user1',
      password: 'correct horse battery staple',
    });
    await sessionsService.revokeAll(first.userId);
    await expect(authService.me(first.token)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(authService.me(second.token)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('blocks login and invalidates sessions for a suspended account', async () => {
    const { account, password } = await createActiveUser();
    const { token, userId } = await authService.login({
      accountOrEmail: account,
      password,
    });
    await prisma.user.update({
      where: { account },
      data: { status: 'SUSPENDED' },
    });
    // Existing session is dead.
    await expect(authService.me(token)).rejects.toBeInstanceOf(UnauthorizedException);
    // New login is forbidden.
    await expect(authService.login({ accountOrEmail: account, password })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    void userId;
  });

  it('rejects login for an INVITED (not yet activated) account', async () => {
    await prisma.user.create({
      data: {
        account: 'invited',
        name: '未激活',
        workEmail: 'invited@example.test',
        status: 'INVITED',
        passwordHash: await passwordHash.hash('correct horse battery staple'),
      },
    });
    await expect(
      authService.login({
        accountOrEmail: 'invited',
        password: 'correct horse battery staple',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
