import { BadRequestException, ConflictException, GoneException } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PrismaService } from '../../src/database/prisma.service';
import { PasswordHashService } from '../../src/crypto/password-hash.service';
import { sha256Hex } from '../../src/crypto/token.util';
import { InvitationsService } from '../../src/modules/users/invitations.service';

/**
 * Integration tests for the invitation lifecycle: admin creation, one-time
 * activation with password setup, expiry, replay rejection and duplicate
 * email protection. Requires a real PostgreSQL on the private Compose network.
 */
const prisma = new PrismaService();

const TABLES = [
  'audit_logs',
  'notifications',
  'email_outbox',
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

let service: InvitationsService;

beforeAll(async () => {
  service = new InvitationsService(prisma, new PasswordHashService());
});

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function createAdminUser(account = 'admin'): Promise<string> {
  const admin = await prisma.user.create({
    data: {
      account,
      name: '管理员',
      workEmail: `${account}@example.test`,
      status: 'ACTIVE',
    },
  });
  const role = await prisma.systemRole.upsert({
    where: { key: 'ADMIN' },
    update: {},
    create: { key: 'ADMIN', name: '系统管理员', requiresMfa: true },
  });
  await prisma.userSystemRole.create({
    data: { userId: admin.id, systemRoleId: role.id },
  });
  return admin.id;
}

describe('InvitationsService', () => {
  it('creates a pending invitation, hashed token and outbox row', async () => {
    const adminId = await createAdminUser();
    const { token, invitation } = await service.createInvitation({
      actorId: adminId,
      email: 'new-hire@example.test',
    });

    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(invitation.status).toBe('PENDING');
    expect(invitation.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const stored = await prisma.invitation.findUniqueOrThrow({
      where: { id: invitation.id },
    });
    // Only the digest is stored; the raw token must not be.
    expect(stored.tokenHash).toBe(sha256Hex(token));
    expect(stored.tokenHash).not.toBe(token);

    const outbox = await prisma.emailOutbox.findFirst({
      where: { toAddress: 'new-hire@example.test' },
    });
    expect(outbox).not.toBeNull();
    expect(outbox?.status).toBe('PENDING');
  });

  it('accepts an invitation once, activating the user with a verifiable password', async () => {
    const adminId = await createAdminUser();
    const { token } = await service.createInvitation({
      actorId: adminId,
      email: 'hire@example.test',
    });

    const user = await service.acceptInvitation({
      token,
      name: '新同事',
      password: 'correct horse battery staple',
    });

    expect(user.status).toBe('ACTIVE');
    expect(user.workEmail).toBe('hire@example.test');

    const passwordHash = new PasswordHashService();
    await expect(
      passwordHash.verify('correct horse battery staple', user.passwordHash ?? ''),
    ).resolves.toBe(true);

    const stored = await prisma.invitation.findFirstOrThrow({
      where: { email: 'hire@example.test' },
    });
    expect(stored.status).toBe('ACCEPTED');
    expect(stored.acceptedAt).not.toBeNull();
  });

  it('rejects replaying an already accepted invitation', async () => {
    const adminId = await createAdminUser();
    const { token } = await service.createInvitation({
      actorId: adminId,
      email: 'replay@example.test',
    });

    await service.acceptInvitation({
      token,
      name: 'Replay User',
      password: 'correct horse battery staple',
    });

    await expect(
      service.acceptInvitation({
        token,
        name: 'Again',
        password: 'another correct pass',
      }),
    ).rejects.toBeInstanceOf(GoneException);
  });

  it('rejects an expired invitation', async () => {
    const adminId = await createAdminUser();
    const { invitation } = await service.createInvitation({
      actorId: adminId,
      email: 'expired@example.test',
    });

    await prisma.invitation.update({
      where: { id: invitation.id },
      data: {
        expiresAt: new Date(Date.now() - 60_000),
        status: 'EXPIRED',
      },
    });

    await expect(
      service.acceptInvitation({
        token: 'any-token',
        name: 'Late',
        password: 'correct horse battery staple',
      }),
    ).rejects.toBeInstanceOf(GoneException);
  });

  it('rejects an unknown token', async () => {
    await expect(
      service.acceptInvitation({
        token: 'no-such-token',
        name: 'Nobody',
        password: 'correct horse battery staple',
      }),
    ).rejects.toBeInstanceOf(GoneException);
  });

  it('rejects a duplicate pending invitation for the same email', async () => {
    const adminId = await createAdminUser();
    await service.createInvitation({
      actorId: adminId,
      email: 'dupe@example.test',
    });

    await expect(
      service.createInvitation({
        actorId: adminId,
        email: 'dupe@example.test',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects inviting an email that already belongs to a user', async () => {
    const adminId = await createAdminUser();
    await prisma.user.create({
      data: {
        account: 'existing',
        name: '已有用户',
        workEmail: 'existing@example.test',
        status: 'ACTIVE',
      },
    });

    await expect(
      service.createInvitation({
        actorId: adminId,
        email: 'existing@example.test',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects an invalid email format', async () => {
    const adminId = await createAdminUser();
    await expect(
      service.createInvitation({
        actorId: adminId,
        email: 'not-an-email',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects accepting with a too-short password', async () => {
    const adminId = await createAdminUser();
    const { token } = await service.createInvitation({
      actorId: adminId,
      email: 'shortpw@example.test',
    });

    await expect(
      service.acceptInvitation({
        token,
        name: 'Short PW',
        password: 'short',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
