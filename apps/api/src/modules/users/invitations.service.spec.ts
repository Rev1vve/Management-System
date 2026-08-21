import { afterEach, describe, expect, it, vi } from 'vitest';

import { PasswordHashService } from '../../crypto/password-hash.service';
import { InvitationsService } from './invitations.service';
import type { PrismaService } from '../../database/prisma.service';

describe('InvitationsService invitation email', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('links to the existing activation page with the single-use token', async () => {
    vi.stubEnv('WEB_PUBLIC_BASE_URL', 'https://operations.example.test');
    let emailBody = '';
    const invitation = {
      id: 'invitation-1',
      email: 'new-hire@example.test',
      status: 'PENDING',
      expiresAt: new Date('2026-09-01T00:00:00.000Z'),
    };
    const transactionClient = {
      invitation: {
        create: vi.fn().mockResolvedValue(invitation),
      },
      emailOutbox: {
        create: vi.fn().mockImplementation(({ data }: { data: { body: string } }) => {
          emailBody = data.body;
          return Promise.resolve({ id: 'outbox-1' });
        }),
      },
    };
    const prisma = {
      user: {
        findUnique: vi
          .fn()
          .mockResolvedValueOnce({ id: 'admin-1', status: 'ACTIVE' })
          .mockResolvedValueOnce(null),
      },
      invitation: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
      $transaction: vi
        .fn()
        .mockImplementation(async (callback: (tx: unknown) => unknown) =>
          callback(transactionClient),
        ),
    };
    const service = new InvitationsService(
      prisma as unknown as PrismaService,
      new PasswordHashService(),
    );

    await service.createInvitation({
      actorId: 'admin-1',
      email: 'new-hire@example.test',
    });

    expect(emailBody).toMatch(
      /^欢迎加入项目运营中心。请在 7 天内完成激活：https:\/\/operations\.example\.test\/activate\?token=[A-Za-z0-9_-]+$/,
    );
    expect(emailBody).not.toContain('/invite/accept');
  });
});
