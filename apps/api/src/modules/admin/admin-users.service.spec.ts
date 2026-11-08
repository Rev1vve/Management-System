import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AdminAuditService } from './admin-audit.service';
import { AdminUsersService } from './admin-users.service';

/**
 * 管理中心（任务 11）的边界：
 *  - 用户列表不得返回任何凭据/密钥字段；
 *  - 不能改自己的状态或角色（避免自我锁死）；
 *  - 每个写操作都写审计；
 *  - 审计只有读接口。
 */
function createPrismaMock() {
  return {
    user: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: 'user-1',
          account: 'alice',
          name: 'Alice',
          workEmail: 'alice@example.test',
          status: 'ACTIVE',
          mfaEnabled: true,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          systemRoles: [{ systemRole: { key: 'EMPLOYEE', name: '员工' } }],
        },
      ]),
      count: vi.fn().mockResolvedValue(1),
      findUnique: vi.fn().mockResolvedValue({ id: 'user-1', mfaEnabled: true }),
      update: vi.fn().mockResolvedValue({ id: 'user-1', status: 'SUSPENDED' }),
    },
    systemRole: {
      findMany: vi.fn().mockResolvedValue([{ id: 'role-1', key: 'EMPLOYEE', requiresMfa: false }]),
    },
    userSystemRole: {
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      create: vi.fn().mockResolvedValue({}),
    },
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(undefined)),
    auditLog: {
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
  };
}

function createService(prisma: ReturnType<typeof createPrismaMock>) {
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const sessions = { revokeAll: vi.fn().mockResolvedValue(undefined) };
  const service = new AdminUsersService(prisma as never, audit as never, sessions as never);
  return { service, audit, sessions };
}

describe('AdminUsersService', () => {
  let prisma: ReturnType<typeof createPrismaMock>;

  beforeEach(() => {
    prisma = createPrismaMock();
    prisma.$transaction.mockImplementation(
      async (callback: (tx: typeof prisma) => Promise<unknown>) => callback(prisma),
    );
  });

  it('never returns credential material in the user list', async () => {
    const { service } = createService(prisma);

    const page = await service.listUsers({ page: 1, pageSize: 20 });

    const select = prisma.user.findMany.mock.calls[0]![0].select as Record<string, unknown>;
    expect(select.passwordHash).toBeUndefined();
    expect(select.mfaSecretCiphertext).toBeUndefined();
    expect(select.recoveryCodes).toBeUndefined();
    expect(page.items[0]).toEqual(
      expect.objectContaining({ id: 'user-1', roles: [{ key: 'EMPLOYEE', name: '员工' }] }),
    );
    expect(JSON.stringify(page.items)).not.toContain('passwordHash');
  });

  it('refuses to change your own status or roles', async () => {
    const { service, audit } = createService(prisma);

    await expect(service.setStatus('user-1', 'user-1', 'SUSPENDED')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(service.setRoles('user-1', 'user-1', ['EMPLOYEE'])).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    // 被拒的尝试也要留痕（result=FAILURE），但绝不能真的改到自己的账号。
    expect(audit.record).toHaveBeenCalledTimes(2);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ result: 'FAILURE' }));
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('records an audit entry when the status changes', async () => {
    const { service, audit } = createService(prisma);

    await service.setStatus('admin-1', 'user-1', 'SUSPENDED');

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: 'admin-1',
        action: 'user.status.changed',
        resourceType: 'USER',
        resourceId: 'user-1',
      }),
    );
  });

  it('rejects an unknown status or unknown role key', async () => {
    const { service } = createService(prisma);

    await expect(service.setStatus('admin-1', 'user-1', 'DELETED')).rejects.toBeInstanceOf(
      BadRequestException,
    );

    prisma.systemRole.findMany.mockResolvedValue([]);
    await expect(service.setRoles('admin-1', 'user-1', ['NOPE'])).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('returns 404 for a user that does not exist', async () => {
    const { service } = createService(prisma);
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(service.setStatus('admin-1', 'ghost', 'SUSPENDED')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('lists roles with their permissions so drilldown can be granted', async () => {
    const { service } = createService(prisma);
    prisma.systemRole.findMany.mockResolvedValue([
      {
        key: 'EXECUTIVE',
        name: '高层领导',
        description: null,
        requiresMfa: true,
        rolePermissions: [{ permission: { key: 'report:view' } }],
      },
    ]);

    const roles = await service.listRoles();

    expect(roles).toEqual([
      {
        key: 'EXECUTIVE',
        name: '高层领导',
        description: null,
        requiresMfa: true,
        permissions: ['report:view'],
      },
    ]);
  });

  it('refuses a privileged role when the target has no TOTP, and audits the refusal', async () => {
    const prisma = createPrismaMock();
    prisma.systemRole.findMany.mockResolvedValue([
      { id: 'role-1', key: 'EXECUTIVE', requiresMfa: true },
    ]);
    prisma.user.findUnique.mockResolvedValue({ id: 'user-1', mfaEnabled: false });
    const { service, audit, sessions } = createService(prisma);

    await expect(service.setRoles('admin-1', 'user-1', ['EXECUTIVE'])).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.userSystemRole.deleteMany).not.toHaveBeenCalled();
    expect(sessions.revokeAll).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'user.roles.changed', result: 'FAILURE' }),
    );
  });

  it('revokes sessions when a status change suspends the account', async () => {
    const { service, sessions } = createService(prisma);

    await service.setStatus('admin-1', 'user-1', 'SUSPENDED');

    expect(sessions.revokeAll).toHaveBeenCalledWith('user-1');
  });

  it('revokes sessions after a role change so new rights require a fresh login', async () => {
    const { service, sessions } = createService(prisma);

    await service.setRoles('admin-1', 'user-1', ['EMPLOYEE']);

    expect(sessions.revokeAll).toHaveBeenCalledWith('user-1');
  });

  it('audits rejected operations instead of failing silently', async () => {
    const { service, audit } = createService(prisma);

    await expect(service.setStatus('admin-1', 'user-1', 'DELETED')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(service.setStatus('user-1', 'user-1', 'SUSPENDED')).rejects.toBeInstanceOf(
      ForbiddenException,
    );

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'user.status.changed', result: 'FAILURE' }),
    );
  });

  it('never stores client-supplied secrets in the failure audit summary', async () => {
    const { service, audit } = createService(prisma);

    await expect(
      service.setStatus('admin-1', 'user-1', 'password=hunter2 token=abc123'),
    ).rejects.toBeInstanceOf(BadRequestException);

    const summary = (audit.record.mock.calls[0]![0] as { summary: string }).summary;
    expect(summary).not.toContain('hunter2');
    expect(summary).not.toContain('abc123');
    // 失败审计同样走默认脱敏，不显式关闭。
    const call = audit.record.mock.calls[0]![0] as { redactSensitive?: boolean };
    expect(call.redactSensitive).not.toBe(false);
  });
});

describe('AdminAuditService', () => {
  it('rejects impossible calendar dates and inverted ranges', async () => {
    const prisma = createPrismaMock();
    const service = new AdminAuditService(prisma as never);

    await expect(service.list({ from: '2026-02-31' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.list({ from: '2026-11-08', to: '2026-11-01' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('lists audit rows read-only with a stable order and filters', async () => {
    const prisma = createPrismaMock();
    const service = new AdminAuditService(prisma as never);

    const page = await service.list({ page: 2, pageSize: 10, actorId: 'admin-1' });

    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ actorId: 'admin-1' }),
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: 10,
        take: 10,
      }),
    );
    expect(page.timezone).toBe('Australia/Melbourne');
  });

  it('rejects a malformed date filter instead of failing later', async () => {
    const prisma = createPrismaMock();
    const service = new AdminAuditService(prisma as never);

    await expect(service.list({ from: '2026-11-8' })).rejects.toBeInstanceOf(BadRequestException);
  });
});
