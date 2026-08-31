import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { ProjectsService } from './projects.service';

const projectManage = { listUserPermissions: vi.fn().mockResolvedValue(['project:manage']) };

describe('ProjectsService', () => {
  it('lists only active records inside the authenticated user project scope', async () => {
    const prisma = {
      project: {
        count: vi.fn().mockResolvedValue(1),
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'project-1',
            number: 'PRJ-0001',
            name: '内部项目',
            description: null,
            startDate: null,
            endDate: null,
            status: 'ACTIVE',
            completionPercent: 25,
            version: 3,
            updatedAt: new Date('2026-08-22T00:00:00.000Z'),
            customer: {
              id: 'customer-1',
              number: 'CUST-0001',
              name: '客户甲',
              status: 'ACTIVE',
              deletedAt: null,
            },
            portfolio: null,
          },
        ]),
      },
    };
    const projectAccess = {
      resolveProjectScope: vi.fn().mockResolvedValue(['project-1']),
      listProjectRoles: vi.fn().mockResolvedValue(['PROJECT_MANAGER']),
    };
    const service = new ProjectsService(
      prisma as never,
      projectAccess as never,
      projectManage as never,
    );

    const result = await service.list('user-1', { page: 1, pageSize: 20 });

    expect(projectAccess.resolveProjectScope).toHaveBeenCalledWith('user-1');
    const activeScope = {
      id: { in: ['project-1'] },
      deletedAt: null,
      memberships: {
        some: { userId: 'user-1', user: { status: 'ACTIVE', deletedAt: null } },
      },
      AND: [{ status: { not: 'ARCHIVED' } }],
    };
    expect(prisma.project.count).toHaveBeenCalledWith({ where: activeScope });
    expect(prisma.project.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          ...activeScope,
          memberships: {
            some: {
              userId: 'user-1',
              user: { status: 'ACTIVE', deletedAt: null },
            },
          },
        }),
        skip: 0,
        take: 20,
      }),
    );
    expect(result).toEqual({
      items: [
        expect.objectContaining({
          id: 'project-1',
          number: 'PRJ-0001',
          name: '内部项目',
          customer: { id: 'customer-1', number: 'CUST-0001', name: '客户甲' },
        }),
      ],
      page: 1,
      pageSize: 20,
      total: 1,
      totalPages: 1,
      canManage: true,
    });
  });

  it('does not expose archived customer or portfolio relations from project list responses', async () => {
    const prisma = {
      project: {
        count: vi.fn().mockResolvedValue(2),
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'project-customer',
            number: 'PRJ-C',
            name: '归档客户关联',
            customer: {
              id: 'customer-archived',
              number: 'CUST-A',
              name: '已归档客户',
              status: 'ARCHIVED',
              deletedAt: null,
            },
            portfolio: null,
          },
          {
            id: 'project-portfolio',
            number: 'PRJ-P',
            name: '归档项目集关联',
            customer: null,
            portfolio: {
              id: 'portfolio-archived',
              name: '已归档项目集',
              status: 'ACTIVE',
              deletedAt: new Date('2026-08-23T00:00:00.000Z'),
            },
          },
        ]),
      },
    };
    const access = {
      resolveProjectScope: vi.fn().mockResolvedValue(['project-customer', 'project-portfolio']),
    };
    const service = new ProjectsService(prisma as never, access as never, projectManage as never);

    const result = await service.list('u1', { page: 1, pageSize: 20 });

    expect(result.items).toEqual([
      expect.objectContaining({ id: 'project-customer', customer: null, portfolio: null }),
      expect.objectContaining({ id: 'project-portfolio', customer: null, portfolio: null }),
    ]);
    expect(JSON.stringify(result.items)).not.toContain('ARCHIVED');
    expect(JSON.stringify(result.items)).not.toContain('deletedAt');
  });

  it('does not expose archived customer or portfolio relations from project detail responses', async () => {
    const detail = {
      id: 'project-1',
      number: 'PRJ-0001',
      name: '内部项目',
      version: 1,
      customer: {
        id: 'customer-archived',
        number: 'CUST-A',
        name: '已归档客户',
        status: 'ARCHIVED',
        deletedAt: null,
      },
      portfolio: {
        id: 'portfolio-archived',
        name: '已归档项目集',
        status: 'ARCHIVED',
        deletedAt: new Date('2026-08-23T00:00:00.000Z'),
      },
    };
    const prisma = { project: { findFirst: vi.fn().mockResolvedValue(detail) } };
    const access = { assertProjectAccess: vi.fn().mockResolvedValue({ roles: ['MEMBER'] }) };
    const service = new ProjectsService(prisma as never, access as never, projectManage as never);

    await expect(service.get('u1', 'project-1')).resolves.toEqual({
      ...detail,
      customer: null,
      portfolio: null,
    });
  });

  it('cannot re-expose archived projects through an explicit status query', async () => {
    const prisma = {
      project: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
    };
    const access = { resolveProjectScope: vi.fn().mockResolvedValue(['archived-project']) };
    const service = new ProjectsService(prisma as never, access as never, projectManage as never);

    await service.list('u1', { page: 1, pageSize: 20, status: 'ARCHIVED' });

    expect(prisma.project.count).toHaveBeenCalledWith({
      where: {
        id: { in: ['archived-project'] },
        deletedAt: null,
        memberships: {
          some: { userId: 'u1', user: { status: 'ACTIVE', deletedAt: null } },
        },
        AND: [{ status: { not: 'ARCHIVED' } }, { status: 'ARCHIVED' }],
      },
    });
  });

  it('advertises project creation from system permission even before the first project exists', async () => {
    const prisma = {
      project: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
    };
    const access = { resolveProjectScope: vi.fn().mockResolvedValue([]) };
    const denied = new ProjectsService(
      prisma as never,
      access as never,
      { listUserPermissions: vi.fn().mockResolvedValue([]) } as never,
    );
    await expect(denied.list('u1', { page: 1, pageSize: 20 })).resolves.toMatchObject({
      canManage: false,
    });

    const allowed = new ProjectsService(
      prisma as never,
      access as never,
      { listUserPermissions: vi.fn().mockResolvedValue(['project:manage']) } as never,
    );
    await expect(allowed.list('u1', { page: 1, pageSize: 20 })).resolves.toMatchObject({
      canManage: true,
    });
  });

  it('keeps per-project management on detail responses rather than inferring it from another project', async () => {
    const prisma = {
      project: { count: vi.fn().mockResolvedValue(2), findMany: vi.fn().mockResolvedValue([]) },
    };
    const access = { resolveProjectScope: vi.fn().mockResolvedValue(['managed', 'member']) };
    const roles = { listUserPermissions: vi.fn().mockResolvedValue(['project:manage']) };
    const service = new ProjectsService(prisma as never, access as never, roles as never);

    await expect(service.list('u1', { page: 1, pageSize: 20 })).resolves.toMatchObject({
      canManage: true,
    });
    expect(access).not.toHaveProperty('listProjectRoles');
  });

  it('rejects ARCHIVED as an ordinary project update status', async () => {
    const service = new ProjectsService({} as never, {} as never, projectManage as never);
    await expect(
      service.update('u1', 'p1', { version: 1, status: 'ARCHIVED' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('does not infer per-project write access from the collection creation capability', async () => {
    const detail = { id: 'project-1', number: 'P-1', name: '成员项目', version: 1 };
    const prisma = { project: { findFirst: vi.fn().mockResolvedValue(detail) } };
    const access = { assertProjectAccess: vi.fn().mockResolvedValue({ roles: ['MEMBER'] }) };
    const roles = { listUserPermissions: vi.fn().mockResolvedValue(['project:manage']) };
    const service = new ProjectsService(prisma as never, access as never, roles as never);

    await expect(service.get('u1', 'project-1')).resolves.toEqual(detail);
  });

  it('does not expose an archived relation from a project creation response', async () => {
    const created = {
      id: 'project-2',
      number: 'PRJ-0002',
      name: '新项目',
      version: 1,
      customer: {
        id: 'customer-archived',
        number: 'CUST-A',
        name: '并发归档客户',
        status: 'ARCHIVED',
        deletedAt: null,
      },
      portfolio: null,
    };
    const tx = {
      user: { findFirst: vi.fn().mockResolvedValue({ id: 'manager-1' }) },
      customer: { findFirst: vi.fn().mockResolvedValue({ id: 'customer-archived' }) },
      project: { create: vi.fn().mockResolvedValue(created) },
      projectMembership: { create: vi.fn().mockResolvedValue({ id: 'membership-1' }) },
    };
    const prisma = {
      customer: { findFirst: vi.fn().mockResolvedValue({ id: 'customer-archived' }) },
      $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)),
    };
    const service = new ProjectsService(prisma as never, {} as never, projectManage as never);

    await expect(
      service.create('manager-1', {
        number: 'PRJ-0002',
        name: '新项目',
        customerId: 'customer-archived',
      }),
    ).resolves.toEqual({ ...created, customer: null });
  });

  it('creates a project and its creator manager membership atomically', async () => {
    const created = { id: 'project-2', number: 'PRJ-0002', name: '新项目', version: 1 };
    const tx = {
      user: { findFirst: vi.fn().mockResolvedValue({ id: 'manager-1' }) },
      project: { create: vi.fn().mockResolvedValue(created) },
      projectMembership: { create: vi.fn().mockResolvedValue({ id: 'membership-1' }) },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)),
    };
    const service = new ProjectsService(prisma as never, {} as never, projectManage as never);

    await expect(
      service.create('manager-1', {
        number: 'PRJ-0002',
        name: '新项目',
      }),
    ).resolves.toEqual(created);
    expect(tx.projectMembership.create).toHaveBeenCalledWith({
      data: {
        userId: 'manager-1',
        projectId: 'project-2',
        roles: { create: [{ role: 'PROJECT_MANAGER' }] },
      },
    });
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'Serializable',
    });
  });

  it('returns a project detail only after membership access is established', async () => {
    const detail = { id: 'project-1', number: 'PRJ-0001', name: '内部项目', version: 1 };
    const prisma = { project: { findFirst: vi.fn().mockResolvedValue(detail) } };
    const projectAccess = { assertProjectAccess: vi.fn().mockResolvedValue({ roles: ['MEMBER'] }) };
    const service = new ProjectsService(
      prisma as never,
      projectAccess as never,
      projectManage as never,
    );

    await expect(service.get('user-1', 'project-1')).resolves.toEqual(detail);
    expect(projectAccess.assertProjectAccess).toHaveBeenCalledWith('user-1', 'project-1');
    expect(prisma.project.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'project-1',
          status: { not: 'ARCHIVED' },
          deletedAt: null,
          memberships: {
            some: {
              userId: 'user-1',
              user: { status: 'ACTIVE', deletedAt: null },
            },
          },
        },
      }),
    );
  });

  it('returns an explicit write capability only when project role and system permission both allow it', async () => {
    const detail = { id: 'project-1', number: 'PRJ-0001', name: '内部项目', version: 1 };
    const prisma = { project: { findFirst: vi.fn().mockResolvedValue(detail) } };
    const projectAccess = {
      assertProjectAccess: vi.fn().mockResolvedValue({ roles: ['PROJECT_MANAGER'] }),
    };
    const roles = { listUserPermissions: vi.fn().mockResolvedValue(['project:manage']) };
    const service = new ProjectsService(prisma as never, projectAccess as never, roles as never);

    await expect(service.get('user-1', 'project-1')).resolves.toEqual({
      ...detail,
      canManage: true,
    });
  });

  it('fails closed on unknown update fields and invalid project roles', async () => {
    const access = { assertProjectRole: vi.fn().mockResolvedValue(undefined) };
    const service = new ProjectsService({} as never, access as never, projectManage as never);
    await expect(
      service.update('u1', 'p1', { version: 1, deletedAt: new Date() } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.addMember('u1', 'p1', 'u2', ['OWNER'])).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(service.addMember('u1', 'p1', 'u2', [])).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it.each(['MEMBER', 'PROJECT_MANAGER', 'APPROVER', 'OBSERVER'])(
    'accepts schema project role %s',
    async (role) => {
      const tx = {
        projectMembership: {
          findFirst: vi.fn().mockResolvedValue({ id: 'actor-membership' }),
          create: vi
            .fn()
            .mockResolvedValue({ id: 'membership-1', userId: 'user-2', roles: [{ role }] }),
        },
      };
      const prisma = {
        $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)),
      };
      const access = { assertProjectRole: vi.fn().mockResolvedValue(undefined) };
      const service = new ProjectsService(prisma as never, access as never, projectManage as never);

      await expect(
        service.addMember('manager-1', 'project-1', 'user-2', [role]),
      ).resolves.toMatchObject({ id: 'membership-1' });
      expect(tx.projectMembership.findFirst).toHaveBeenCalledOnce();
      expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
        isolationLevel: 'Serializable',
      });
    },
  );

  it('validates customer and portfolio references inside the creator scope', async () => {
    const prisma = {
      customer: { findFirst: vi.fn().mockResolvedValue(null) },
      portfolio: { findFirst: vi.fn() },
    };
    const service = new ProjectsService(prisma as never, {} as never, projectManage as never);
    await expect(
      service.create('u1', { number: 'P1', name: 'x', customerId: 'c-other' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.customer.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          projects: {
            some: expect.objectContaining({ memberships: { some: expect.any(Object) } }),
          },
        }),
      }),
    );
  });

  it('distinguishes an inaccessible or archived project from a stale version', async () => {
    const prisma = { project: { findFirst: vi.fn().mockResolvedValue(null), updateMany: vi.fn() } };
    const access = { assertProjectRole: vi.fn().mockResolvedValue(undefined) };
    const service = new ProjectsService(prisma as never, access as never, projectManage as never);
    await expect(service.update('u1', 'p1', { version: 1, name: 'x' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.project.updateMany).not.toHaveBeenCalled();
  });

  it('protects the final project manager during role replacement', async () => {
    const tx = {
      projectMembership: {
        findFirst: vi.fn().mockResolvedValue({ id: 'actor-membership' }),
        findUnique: vi.fn().mockResolvedValue({ id: 'm1', roles: [{ role: 'PROJECT_MANAGER' }] }),
        count: vi.fn().mockResolvedValue(1),
      },
      projectMembershipRole: { deleteMany: vi.fn(), createMany: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)),
    };
    const access = { assertProjectRole: vi.fn().mockResolvedValue(undefined) };
    const service = new ProjectsService(prisma as never, access as never, projectManage as never);
    await expect(service.replaceMemberRoles('u1', 'p1', 'u1', ['MEMBER'])).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(tx.projectMembership.count).toHaveBeenCalledWith({
      where: {
        projectId: 'p1',
        roles: { some: { role: 'PROJECT_MANAGER' } },
        user: {
          status: 'ACTIVE',
          deletedAt: null,
          systemRoles: {
            some: {
              systemRole: {
                rolePermissions: {
                  some: { permission: { key: 'project:manage' } },
                },
              },
            },
          },
        },
      },
    });
    expect(tx.projectMembershipRole.deleteMany).not.toHaveBeenCalled();
  });

  it('retries a serializable manager demotion and rechecks membership and manager count', async () => {
    const firstTx = {
      projectMembership: {
        findFirst: vi.fn().mockResolvedValue({ id: 'actor-membership' }),
        findUnique: vi.fn().mockResolvedValue({ id: 'm1', roles: [{ role: 'PROJECT_MANAGER' }] }),
        count: vi.fn().mockResolvedValue(2),
      },
      projectMembershipRole: {
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const secondTx = {
      projectMembership: {
        findFirst: vi.fn().mockResolvedValue({ id: 'actor-membership' }),
        findUnique: vi.fn().mockResolvedValue({ id: 'm1', roles: [{ role: 'PROJECT_MANAGER' }] }),
        count: vi.fn().mockResolvedValue(1),
      },
      projectMembershipRole: { deleteMany: vi.fn(), createMany: vi.fn() },
    };
    const transactions = [firstTx, secondTx];
    const prisma = {
      $transaction: vi.fn(async (callback: (tx: typeof firstTx) => unknown) => {
        const attempt = prisma.$transaction.mock.calls.length - 1;
        const result = await callback(transactions[attempt] as typeof firstTx);
        if (attempt === 0) throw Object.assign(new Error('write conflict'), { code: 'P2034' });
        return result;
      }),
    };
    const access = { assertProjectRole: vi.fn().mockResolvedValue(undefined) };
    const service = new ProjectsService(prisma as never, access as never, projectManage as never);

    await expect(service.replaceMemberRoles('u1', 'p1', 'u1', ['MEMBER'])).rejects.toBeInstanceOf(
      ConflictException,
    );

    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(prisma.$transaction).toHaveBeenNthCalledWith(1, expect.any(Function), {
      isolationLevel: 'Serializable',
    });
    expect(prisma.$transaction).toHaveBeenNthCalledWith(2, expect.any(Function), {
      isolationLevel: 'Serializable',
    });
    expect(firstTx.projectMembership.findUnique).toHaveBeenCalledOnce();
    expect(secondTx.projectMembership.findUnique).toHaveBeenCalledOnce();
    expect(firstTx.projectMembership.count).toHaveBeenCalledOnce();
    expect(secondTx.projectMembership.count).toHaveBeenCalledOnce();
    expect(secondTx.projectMembershipRole.deleteMany).not.toHaveBeenCalled();
  });

  it('retries a serializable manager removal and rechecks membership and manager count', async () => {
    const firstTx = {
      projectMembership: {
        findFirst: vi.fn().mockResolvedValue({ id: 'actor-membership' }),
        findUnique: vi.fn().mockResolvedValue({ id: 'm1', roles: [{ role: 'PROJECT_MANAGER' }] }),
        count: vi.fn().mockResolvedValue(2),
        delete: vi.fn().mockResolvedValue({ id: 'm1' }),
      },
      projectMembershipRole: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    const secondTx = {
      projectMembership: {
        findFirst: vi.fn().mockResolvedValue({ id: 'actor-membership' }),
        findUnique: vi.fn().mockResolvedValue({ id: 'm1', roles: [{ role: 'PROJECT_MANAGER' }] }),
        count: vi.fn().mockResolvedValue(1),
        delete: vi.fn(),
      },
      projectMembershipRole: { deleteMany: vi.fn() },
    };
    const transactions = [firstTx, secondTx];
    const prisma = {
      $transaction: vi.fn(async (callback: (tx: typeof firstTx) => unknown) => {
        const attempt = prisma.$transaction.mock.calls.length - 1;
        const result = await callback(transactions[attempt] as typeof firstTx);
        if (attempt === 0) throw Object.assign(new Error('write conflict'), { code: 'P2034' });
        return result;
      }),
    };
    const access = { assertProjectRole: vi.fn().mockResolvedValue(undefined) };
    const service = new ProjectsService(prisma as never, access as never, projectManage as never);

    await expect(service.removeMember('u1', 'p1', 'u1')).rejects.toBeInstanceOf(ConflictException);

    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(prisma.$transaction).toHaveBeenNthCalledWith(1, expect.any(Function), {
      isolationLevel: 'Serializable',
    });
    expect(prisma.$transaction).toHaveBeenNthCalledWith(2, expect.any(Function), {
      isolationLevel: 'Serializable',
    });
    expect(firstTx.projectMembership.findUnique).toHaveBeenCalledOnce();
    expect(secondTx.projectMembership.findUnique).toHaveBeenCalledOnce();
    expect(firstTx.projectMembership.count).toHaveBeenCalledOnce();
    expect(secondTx.projectMembership.count).toHaveBeenCalledOnce();
    expect(firstTx.projectMembershipRole.deleteMany).toHaveBeenCalledWith({
      where: { membershipId: 'm1' },
    });
    expect(secondTx.projectMembershipRole.deleteMany).not.toHaveBeenCalled();
    expect(secondTx.projectMembership.delete).not.toHaveBeenCalled();
  });

  it.each(['replace', 'remove'] as const)(
    'returns not found when the %s target membership is missing',
    async (operation) => {
      const tx = {
        projectMembership: {
          findFirst: vi.fn().mockResolvedValue({ id: 'actor-membership' }),
          findUnique: vi.fn().mockResolvedValue(null),
        },
        projectMembershipRole: { deleteMany: vi.fn(), createMany: vi.fn() },
      };
      const prisma = {
        $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)),
      };
      const access = { assertProjectRole: vi.fn().mockResolvedValue(undefined) };
      const service = new ProjectsService(prisma as never, access as never, projectManage as never);

      const result =
        operation === 'replace'
          ? service.replaceMemberRoles('u1', 'p1', 'missing', ['MEMBER'])
          : service.removeMember('u1', 'p1', 'missing');

      await expect(result).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
        isolationLevel: 'Serializable',
      });
    },
  );

  it('bounds serializable write-conflict retries', async () => {
    const conflict = Object.assign(new Error('write conflict'), { code: 'P2034' });
    const tx = {
      projectMembership: {
        findFirst: vi.fn().mockResolvedValue({ id: 'actor-membership' }),
        findUnique: vi.fn().mockResolvedValue({ id: 'm1', roles: [{ role: 'MEMBER' }] }),
        delete: vi.fn().mockResolvedValue({ id: 'm1' }),
      },
      projectMembershipRole: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => {
        await callback(tx);
        throw conflict;
      }),
    };
    const access = { assertProjectRole: vi.fn().mockResolvedValue(undefined) };
    const service = new ProjectsService(prisma as never, access as never, projectManage as never);

    await expect(service.removeMember('u1', 'p1', 'u2')).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.$transaction).toHaveBeenCalledTimes(3);
    expect(tx.projectMembership.findUnique).toHaveBeenCalledTimes(3);
  });

  it('denies service-layer writes without project:manage before resource lookups', async () => {
    const access = { assertProjectRole: vi.fn() };
    const roles = { listUserPermissions: vi.fn().mockResolvedValue([]) };
    const service = new ProjectsService({} as never, access as never, roles as never);

    await expect(service.archive('u1', 'p1', 1)).rejects.toBeInstanceOf(ForbiddenException);
    expect(access.assertProjectRole).not.toHaveBeenCalled();
  });

  it('rechecks project-manager membership in the atomic archive predicate', async () => {
    const prisma = {
      project: {
        findFirst: vi.fn().mockResolvedValue({ id: 'p1' }),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    };
    const access = { assertProjectRole: vi.fn().mockResolvedValue(undefined) };
    const service = new ProjectsService(prisma as never, access as never, projectManage as never);

    await expect(service.archive('u1', 'p1', 1)).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.project.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'p1',
          memberships: {
            some: expect.objectContaining({ userId: 'u1' }),
          },
        }),
      }),
    );
  });

  it.each(['update', 'archive'] as const)(
    'rechecks active manager membership and project:manage in the final %s predicate',
    async (operation) => {
      const prisma = {
        project: {
          findFirst: vi.fn().mockResolvedValue({ id: 'p1' }),
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        $transaction: vi.fn(async (callback: (value: unknown) => unknown) => callback(prisma)),
      };
      const access = { assertProjectRole: vi.fn().mockResolvedValue(undefined) };
      const service = new ProjectsService(prisma as never, access as never, projectManage as never);

      const result =
        operation === 'update'
          ? service.update('u1', 'p1', { version: 1, name: 'new' })
          : service.archive('u1', 'p1', 1);
      await expect(result).rejects.toBeDefined();

      expect(prisma.project.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            memberships: {
              some: {
                userId: 'u1',
                roles: { some: { role: 'PROJECT_MANAGER' } },
                user: expect.objectContaining({
                  status: 'ACTIVE',
                  deletedAt: null,
                  systemRoles: {
                    some: {
                      systemRole: {
                        rolePermissions: {
                          some: { permission: { key: 'project:manage' } },
                        },
                      },
                    },
                  },
                }),
              },
            },
          }),
        }),
      );
    },
  );

  it('returns project members only from a final query that rechecks active membership', async () => {
    const prisma = {
      project: { findFirst: vi.fn().mockResolvedValue({ memberships: [] }) },
    };
    const access = { assertProjectAccess: vi.fn().mockResolvedValue({ roles: ['MEMBER'] }) };
    const service = new ProjectsService(prisma as never, access as never, projectManage as never);

    await expect(service.listMembers('u1', 'p1')).resolves.toEqual([]);

    expect(prisma.project.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'p1',
        status: { not: 'ARCHIVED' },
        deletedAt: null,
        memberships: {
          some: { userId: 'u1', user: { status: 'ACTIVE', deletedAt: null } },
        },
      },
      select: {
        memberships: {
          select: {
            id: true,
            userId: true,
            user: { select: { id: true, name: true, workEmail: true } },
            roles: { select: { role: true } },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
  });

  it('binds a new member only after a serializable current-manager check', async () => {
    const tx = {
      projectMembership: {
        findFirst: vi.fn().mockResolvedValue({ id: 'actor-membership' }),
        create: vi.fn().mockResolvedValue({ id: 'm2', userId: 'u2', roles: [{ role: 'MEMBER' }] }),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)),
    };
    const access = { assertProjectRole: vi.fn().mockResolvedValue(undefined) };
    const service = new ProjectsService(prisma as never, access as never, projectManage as never);

    await service.addMember('u1', 'p1', 'u2', ['MEMBER']);

    expect(tx.projectMembership.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: 'u1',
          projectId: 'p1',
          roles: { some: { role: 'PROJECT_MANAGER' } },
        }),
      }),
    );
    expect(tx.projectMembership.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ userId: 'u2', projectId: 'p1' }) }),
    );
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'Serializable',
    });
  });

  it.each(['replace', 'remove'] as const)(
    'rechecks the acting manager authorization inside the serializable %s transaction',
    async (operation) => {
      const tx = {
        projectMembership: {
          findFirst: vi.fn().mockResolvedValue({ id: 'actor' }),
          findUnique: vi.fn().mockResolvedValue({ id: 'target', roles: [{ role: 'MEMBER' }] }),
          delete: vi.fn().mockResolvedValue({ id: 'target' }),
        },
        projectMembershipRole: {
          deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
          createMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
      };
      const prisma = {
        $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)),
      };
      const access = { assertProjectRole: vi.fn().mockResolvedValue(undefined) };
      const service = new ProjectsService(prisma as never, access as never, projectManage as never);

      if (operation === 'replace') {
        await service.replaceMemberRoles('u1', 'p1', 'u2', ['MEMBER']);
      } else {
        await service.removeMember('u1', 'p1', 'u2');
      }

      expect(tx.projectMembership.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            userId: 'u1',
            projectId: 'p1',
            roles: { some: { role: 'PROJECT_MANAGER' } },
            user: expect.objectContaining({ status: 'ACTIVE', deletedAt: null }),
          }),
        }),
      );
    },
  );
});
