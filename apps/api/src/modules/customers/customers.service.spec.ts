import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { CustomersService } from './customers.service';

const projectManage = { listUserPermissions: vi.fn().mockResolvedValue(['project:manage']) };

describe('CustomersService', () => {
  it('scopes customer lists through accessible projects and hides sensitive fields for ordinary members', async () => {
    const prisma = {
      customer: {
        count: vi.fn().mockResolvedValue(1),
        findMany: vi.fn().mockResolvedValue([{ id: 'c1', number: 'C-1', name: '客户' }]),
      },
    };
    const access = {
      resolveProjectScope: vi.fn().mockResolvedValue(['p1']),
      listProjectRoles: vi.fn().mockResolvedValue(['MEMBER']),
    };
    const service = new CustomersService(prisma as never, access as never, projectManage as never);
    const result = await service.list('u1', { page: 1, pageSize: 20 });
    expect(prisma.customer.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          AND: [{ status: { not: 'ARCHIVED' } }],
          projects: {
            some: expect.objectContaining({
              id: { in: ['p1'] },
              status: { not: 'ARCHIVED' },
              deletedAt: null,
              memberships: { some: expect.objectContaining({ userId: 'u1' }) },
            }),
          },
        }),
        select: expect.not.objectContaining({ notes: true, contacts: expect.anything() }),
      }),
    );
    expect(result.items[0]).not.toHaveProperty('notes');
    expect(result.canManage).toBe(false);
  });

  it('rechecks current active membership in the final base customer query', async () => {
    const prisma = {
      customer: {
        count: vi.fn().mockResolvedValue(0),
        findMany: vi.fn().mockResolvedValue([]),
      },
    };
    const access = {
      resolveProjectScope: vi.fn().mockResolvedValue(['p1']),
      listProjectRoles: vi.fn().mockResolvedValue(['MEMBER']),
    };
    const service = new CustomersService(prisma as never, access as never, projectManage as never);

    await service.list('u1', { page: 1, pageSize: 20 });

    expect(prisma.customer.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          projects: {
            some: expect.objectContaining({
              status: { not: 'ARCHIVED' },
              deletedAt: null,
              memberships: {
                some: {
                  userId: 'u1',
                  user: { status: 'ACTIVE', deletedAt: null },
                },
              },
            }),
          },
        }),
      }),
    );
  });

  it('cannot re-expose archived customers through an explicit status query', async () => {
    const prisma = {
      customer: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
    };
    const access = {
      resolveProjectScope: vi.fn().mockResolvedValue(['p1']),
      listProjectRoles: vi.fn().mockResolvedValue(['MEMBER']),
    };
    const service = new CustomersService(prisma as never, access as never, projectManage as never);

    await service.list('u1', { page: 1, pageSize: 20, status: 'ARCHIVED' });

    expect(prisma.customer.count).toHaveBeenCalledWith({
      where: expect.objectContaining({
        AND: [{ status: { not: 'ARCHIVED' } }, { status: 'ARCHIVED' }],
      }),
    });
  });

  it('advertises collection creation only with system permission and a managed project scope', async () => {
    const prisma = {
      customer: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
    };
    const access = {
      resolveProjectScope: vi.fn().mockResolvedValue(['p1']),
      listProjectRoles: vi.fn().mockResolvedValue(['PROJECT_MANAGER']),
    };
    const roles = { listUserPermissions: vi.fn().mockResolvedValue(['project:manage']) };
    const service = new CustomersService(prisma as never, access as never, roles as never);

    await expect(service.list('u1', { page: 1, pageSize: 20 })).resolves.toMatchObject({
      canManage: true,
    });
  });

  it('rechecks deletedAt before returning sensitive customer list fields', async () => {
    const base = {
      id: 'c1',
      number: 'C-1',
      name: '客户',
      status: 'ACTIVE',
      version: 1,
      updatedAt: new Date(),
    };
    const prisma = {
      customer: {
        count: vi.fn().mockResolvedValue(1),
        findMany: vi.fn().mockResolvedValueOnce([base]).mockResolvedValueOnce([]),
      },
    };
    const access = {
      resolveProjectScope: vi.fn().mockResolvedValue(['p1']),
      listProjectRoles: vi.fn().mockResolvedValue(['PROJECT_MANAGER']),
    };
    const service = new CustomersService(prisma as never, access as never, projectManage as never);

    await service.list('u1', { page: 1, pageSize: 20 });

    expect(prisma.customer.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({ id: { in: ['c1'] }, deletedAt: null }),
      }),
    );
  });

  it('rechecks current project membership, manager role and system permission in the sensitive query', async () => {
    const base = {
      id: 'c1',
      number: 'C-1',
      name: '客户',
      status: 'ACTIVE',
      version: 1,
      updatedAt: new Date(),
    };
    const prisma = {
      customer: {
        count: vi.fn().mockResolvedValue(1),
        findMany: vi.fn().mockResolvedValueOnce([base]).mockResolvedValueOnce([]),
      },
    };
    const access = {
      resolveProjectScope: vi.fn().mockResolvedValue(['p1']),
      listProjectRoles: vi.fn().mockResolvedValue(['PROJECT_MANAGER']),
    };
    const service = new CustomersService(prisma as never, access as never, projectManage as never);

    await service.list('u1', { page: 1, pageSize: 20 });

    expect(prisma.customer.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          projects: {
            some: expect.objectContaining({
              status: 'ACTIVE',
              deletedAt: null,
              memberships: {
                some: expect.objectContaining({
                  userId: 'u1',
                  roles: { some: { role: 'PROJECT_MANAGER' } },
                  user: expect.objectContaining({
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
                }),
              },
            }),
          },
        }),
      }),
    );
  });

  it('does not expose sensitive list fields to a project manager without system project management permission', async () => {
    const base = {
      id: 'c1',
      number: 'C-1',
      name: '客户',
      status: 'ACTIVE',
      version: 1,
      updatedAt: new Date(),
    };
    const prisma = {
      customer: {
        count: vi.fn().mockResolvedValue(1),
        findMany: vi
          .fn()
          .mockResolvedValueOnce([base])
          .mockResolvedValueOnce([{ ...base, notes: '机密', contacts: [{ id: 'ct1' }] }]),
      },
    };
    const access = {
      resolveProjectScope: vi.fn().mockResolvedValue(['p1']),
      listProjectRoles: vi.fn().mockResolvedValue(['PROJECT_MANAGER']),
    };
    const roles = { listUserPermissions: vi.fn().mockResolvedValue([]) };
    const service = new CustomersService(prisma as never, access as never, roles as never);

    const result = await service.list('u1', { page: 1, pageSize: 20 });

    expect(result.items).toEqual([base]);
    expect(result.items[0]).not.toHaveProperty('notes');
    expect(result.items[0]).not.toHaveProperty('contacts');
    expect(prisma.customer.findMany).toHaveBeenCalledTimes(1);
  });

  it('creates a customer and conditionally binds it to one unarchived project in one transaction', async () => {
    const tx = {
      customer: { create: vi.fn().mockResolvedValue({ id: 'c1', version: 1 }) },
      project: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    const prisma = { $transaction: vi.fn(async (cb: (value: typeof tx) => unknown) => cb(tx)) };
    const access = { assertProjectRole: vi.fn().mockResolvedValue(undefined) };
    const service = new CustomersService(prisma as never, access as never, projectManage as never);
    await service.create('u1', { projectId: 'p1', number: 'C-1', name: '客户' });
    expect(access.assertProjectRole).toHaveBeenCalledWith('u1', 'p1', ['PROJECT_MANAGER']);
    expect(tx.project.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: 'p1',
        customerId: null,
        status: 'ACTIVE',
        deletedAt: null,
        memberships: { some: expect.objectContaining({ userId: 'u1' }) },
      }),
      data: { customerId: 'c1' },
    });
  });

  it('returns conflict inside the transaction when the project already has a customer', async () => {
    const tx = {
      customer: { create: vi.fn().mockResolvedValue({ id: 'new-customer', version: 1 }) },
      project: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        findFirst: vi.fn().mockResolvedValue({ id: 'p1' }),
      },
    };
    const prisma = { $transaction: vi.fn(async (cb: (value: typeof tx) => unknown) => cb(tx)) };
    const access = { assertProjectRole: vi.fn().mockResolvedValue(undefined) };
    const service = new CustomersService(prisma as never, access as never, projectManage as never);

    await expect(
      service.create('u1', { projectId: 'p1', number: 'C-2', name: '不能成为孤儿的客户' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.project.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: 'p1',
        customerId: null,
        status: 'ACTIVE',
        deletedAt: null,
        memberships: { some: expect.objectContaining({ userId: 'u1' }) },
      }),
      data: { customerId: 'new-customer' },
    });
    expect(tx.project.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'p1' }) }),
    );
  });

  it('uses an atomic version predicate and reports stale updates as conflict', async () => {
    const prisma = {
      customer: {
        findFirst: vi.fn().mockResolvedValue({ id: 'c1' }),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    };
    const access = {
      resolveProjectScope: vi.fn().mockResolvedValue(['p1']),
      listProjectRoles: vi.fn().mockResolvedValue(['PROJECT_MANAGER']),
    };
    const service = new CustomersService(prisma as never, access as never, projectManage as never);
    await expect(service.update('u1', 'c1', { version: 2, name: 'new' })).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(prisma.customer.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'c1', version: 2 }) }),
    );
  });

  it('returns 403 when final customer update authorization is revoked but visibility remains', async () => {
    const prisma = {
      customer: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce({ id: 'c1' })
          .mockResolvedValueOnce({ id: 'c1' })
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({ id: 'c1' }),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    };
    const access = {
      resolveProjectScope: vi.fn().mockResolvedValue(['p1']),
      listProjectRoles: vi.fn().mockResolvedValue(['PROJECT_MANAGER']),
    };
    const service = new CustomersService(prisma as never, access as never, projectManage as never);

    await expect(service.update('u1', 'c1', { version: 2, name: 'new' })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('returns 403 when final customer archive authorization is revoked but visibility remains', async () => {
    const prisma = {
      customer: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce({ id: 'c1' })
          .mockResolvedValueOnce({ id: 'c1' })
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({ id: 'c1' }),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    };
    const access = {
      resolveProjectScope: vi.fn().mockResolvedValue(['p1']),
      listProjectRoles: vi.fn().mockResolvedValue(['PROJECT_MANAGER']),
    };
    const service = new CustomersService(prisma as never, access as never, projectManage as never);

    await expect(service.archive('u1', 'c1', 2)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('fails closed on fields outside the customer update allowlist and direct ARCHIVED writes', async () => {
    const service = new CustomersService({} as never, {} as never, projectManage as never);
    await expect(
      service.update('u1', 'c1', { version: 1, projects: ['p2'] } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.update('u1', 'c1', { version: 1, status: 'ARCHIVED' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('returns an explicit write capability only with system permission and an active managed project', async () => {
    const detail = { id: 'c1', number: 'C-1', name: '客户', version: 1 };
    const prisma = {
      customer: { findFirst: vi.fn().mockResolvedValueOnce(detail).mockResolvedValueOnce(detail) },
    };
    const access = {
      resolveProjectScope: vi.fn().mockResolvedValue(['p1']),
      listProjectRoles: vi.fn().mockResolvedValue(['PROJECT_MANAGER']),
    };
    const roles = { listUserPermissions: vi.fn().mockResolvedValue(['project:manage']) };
    const service = new CustomersService(prisma as never, access as never, roles as never);

    await expect(service.get('u1', 'c1')).resolves.toEqual({ ...detail, canManage: true });
    expect(prisma.customer.findFirst).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({ status: { not: 'ARCHIVED' } }),
      }),
    );
    expect(prisma.customer.findFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          projects: {
            some: expect.objectContaining({
              id: { in: ['p1'] },
              status: 'ACTIVE',
              deletedAt: null,
            }),
          },
        }),
      }),
    );
  });

  it('returns only base customer fields to a project manager without system permission', async () => {
    const base = {
      id: 'c1',
      number: 'C-1',
      name: '客户',
      status: 'ACTIVE',
      version: 1,
      updatedAt: new Date(),
    };
    const prisma = {
      customer: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce(base)
          .mockResolvedValueOnce({ ...base, notes: '机密', contacts: [{ id: 'ct1' }] }),
      },
    };
    const access = {
      resolveProjectScope: vi.fn().mockResolvedValue(['p1']),
      listProjectRoles: vi.fn().mockResolvedValue(['PROJECT_MANAGER']),
    };
    const roles = { listUserPermissions: vi.fn().mockResolvedValue([]) };
    const service = new CustomersService(prisma as never, access as never, roles as never);

    await expect(service.get('u1', 'c1')).resolves.toEqual(base);
    expect(prisma.customer.findFirst).toHaveBeenCalledTimes(1);
  });

  it('returns 403 for a visible customer when the user lacks a project-manager role', async () => {
    const prisma = {
      customer: {
        findFirst: vi.fn().mockResolvedValueOnce({ id: 'c1' }).mockResolvedValueOnce(null),
      },
    };
    const access = {
      resolveProjectScope: vi.fn().mockResolvedValue(['p1']),
      listProjectRoles: vi.fn().mockResolvedValue(['MEMBER']),
    };
    const service = new CustomersService(prisma as never, access as never, projectManage as never);

    await expect(service.assertCustomerManager('u1', 'c1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('returns 404 when the customer is outside the user project scope', async () => {
    const prisma = { customer: { findFirst: vi.fn().mockResolvedValue(null) } };
    const access = {
      resolveProjectScope: vi.fn().mockResolvedValue(['p-other']),
      listProjectRoles: vi.fn().mockResolvedValue(['PROJECT_MANAGER']),
    };
    const service = new CustomersService(prisma as never, access as never, projectManage as never);

    await expect(service.assertCustomerManager('u1', 'c1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('denies service-layer writes without the system permission even for a project manager', async () => {
    const access = {
      assertProjectRole: vi.fn(),
      resolveProjectScope: vi.fn(),
      listProjectRoles: vi.fn(),
    };
    const roles = { listUserPermissions: vi.fn().mockResolvedValue([]) };
    const service = new CustomersService({} as never, access as never, roles as never);

    await expect(
      service.create('u1', { projectId: 'p1', number: 'C-1', name: '客户' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(access.assertProjectRole).not.toHaveBeenCalled();
  });

  it('creates a contact and advances the parent customer version atomically', async () => {
    const contact = { id: 'ct1', customerId: 'c1', name: '联系人甲', isPrimary: true };
    const tx = {
      customer: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      customerContact: { create: vi.fn().mockResolvedValue(contact) },
    };
    const prisma = {
      customer: { findFirst: vi.fn().mockResolvedValue({ id: 'c1' }) },
      $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)),
    };
    const access = {
      resolveProjectScope: vi.fn().mockResolvedValue(['p1']),
      listProjectRoles: vi.fn().mockResolvedValue(['PROJECT_MANAGER']),
    };
    const service = new CustomersService(prisma as never, access as never, projectManage as never);

    await expect(
      service.createContact('u1', 'c1', {
        version: 2,
        name: '联系人甲',
        workEmail: 'contact@example.test',
        isPrimary: true,
      }),
    ).resolves.toEqual(contact);
    expect(tx.customer.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: 'c1',
        version: 2,
        status: { not: 'ARCHIVED' },
        deletedAt: null,
        projects: expect.any(Object),
      }),
      data: { version: { increment: 1 } },
    });
    expect(tx.customerContact.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ customerId: 'c1', name: '联系人甲' }),
      }),
    );
  });

  it('returns 403 when contact creation loses final customer-manager authorization', async () => {
    const tx = {
      customer: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        findFirst: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'c1' }),
      },
      customerContact: { create: vi.fn() },
    };
    const prisma = {
      customer: { findFirst: vi.fn().mockResolvedValue({ id: 'c1' }) },
      $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)),
    };
    const access = {
      resolveProjectScope: vi.fn().mockResolvedValue(['p1']),
      listProjectRoles: vi.fn().mockResolvedValue(['PROJECT_MANAGER']),
    };
    const service = new CustomersService(prisma as never, access as never, projectManage as never);

    await expect(
      service.createContact('u1', 'c1', { version: 2, name: '联系人甲' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(tx.customerContact.create).not.toHaveBeenCalled();
  });

  it.each(['update', 'archive'] as const)(
    'returns 403 when an existing contact loses manager authorization before the final %s lookup',
    async (operation) => {
      const tx = {
        customer: { updateMany: vi.fn() },
        customerContact: {
          findFirst: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'ct1' }),
          update: vi.fn(),
        },
      };
      const prisma = {
        customer: { findFirst: vi.fn().mockResolvedValue({ id: 'c1' }) },
        $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)),
      };
      const access = {
        resolveProjectScope: vi.fn().mockResolvedValue(['p1']),
        listProjectRoles: vi.fn().mockResolvedValue(['PROJECT_MANAGER']),
      };
      const service = new CustomersService(
        prisma as never,
        access as never,
        projectManage as never,
      );

      const result =
        operation === 'update'
          ? service.updateContact('u1', 'c1', 'ct1', { version: 2, name: '新名字' })
          : service.archiveContact('u1', 'c1', 'ct1', 2);
      await expect(result).rejects.toBeInstanceOf(ForbiddenException);
      expect(tx.customer.updateMany).not.toHaveBeenCalled();
      expect(tx.customerContact.update).not.toHaveBeenCalled();
    },
  );

  it.each(['update', 'archive'] as const)(
    'returns 403 when final contact %s loses customer-manager authorization',
    async (operation) => {
      const tx = {
        customer: {
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
          findFirst: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'c1' }),
        },
        customerContact: {
          findFirst: vi.fn().mockResolvedValue({ id: 'ct1' }),
          update: vi.fn(),
        },
      };
      const prisma = {
        customer: { findFirst: vi.fn().mockResolvedValue({ id: 'c1' }) },
        $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)),
      };
      const access = {
        resolveProjectScope: vi.fn().mockResolvedValue(['p1']),
        listProjectRoles: vi.fn().mockResolvedValue(['PROJECT_MANAGER']),
      };
      const service = new CustomersService(
        prisma as never,
        access as never,
        projectManage as never,
      );

      const result =
        operation === 'update'
          ? service.updateContact('u1', 'c1', 'ct1', { version: 2, name: '新名字' })
          : service.archiveContact('u1', 'c1', 'ct1', 2);
      await expect(result).rejects.toBeInstanceOf(ForbiddenException);
      expect(tx.customerContact.update).not.toHaveBeenCalled();
    },
  );

  it('archives a contact without physically deleting it and rejects a stale parent version', async () => {
    const tx = {
      customer: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        findFirst: vi.fn().mockResolvedValue({ id: 'c1' }),
      },
      customerContact: {
        findFirst: vi.fn().mockResolvedValue({ id: 'ct1' }),
        update: vi.fn(),
        delete: vi.fn(),
      },
    };
    const prisma = {
      customer: { findFirst: vi.fn().mockResolvedValue({ id: 'c1' }) },
      $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)),
    };
    const access = {
      resolveProjectScope: vi.fn().mockResolvedValue(['p1']),
      listProjectRoles: vi.fn().mockResolvedValue(['PROJECT_MANAGER']),
    };
    const service = new CustomersService(prisma as never, access as never, projectManage as never);

    await expect(service.archiveContact('u1', 'c1', 'ct1', 1)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(tx.customerContact.update).not.toHaveBeenCalled();
    expect(tx.customerContact.delete).not.toHaveBeenCalled();
  });

  it('returns 403 instead of exposing contacts to an ordinary customer member', async () => {
    const prisma = {
      customer: {
        findFirst: vi.fn().mockResolvedValueOnce({ id: 'c1' }).mockResolvedValueOnce(null),
      },
      customerContact: {
        findMany: vi.fn().mockResolvedValue([{ id: 'ct1', customerId: 'c1', name: '联系人甲' }]),
      },
    };
    const access = {
      resolveProjectScope: vi.fn().mockResolvedValue(['p1']),
      listProjectRoles: vi.fn().mockResolvedValue(['MEMBER']),
    };
    const service = new CustomersService(prisma as never, access as never, projectManage as never);

    await expect(service.listContacts('u1', 'c1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.customerContact.findMany).not.toHaveBeenCalled();
  });

  it('carries current manager authorization into the final contact list query', async () => {
    const prisma = {
      customer: { findFirst: vi.fn().mockResolvedValue({ id: 'c1' }) },
      customerContact: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const access = {
      resolveProjectScope: vi.fn().mockResolvedValue(['p1']),
      listProjectRoles: vi.fn().mockResolvedValue(['PROJECT_MANAGER']),
    };
    const service = new CustomersService(prisma as never, access as never, projectManage as never);

    await service.listContacts('u1', 'c1');

    expect(prisma.customerContact.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          customer: expect.objectContaining({
            projects: {
              some: expect.objectContaining({
                memberships: {
                  some: expect.objectContaining({
                    userId: 'u1',
                    roles: { some: { role: 'PROJECT_MANAGER' } },
                  }),
                },
              }),
            },
          }),
        }),
      }),
    );
  });

  it('returns customerId consistently in customer detail contacts', async () => {
    const prisma = {
      customer: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce({
            id: 'c1',
            number: 'C-1',
            name: '客户',
            status: 'ACTIVE',
            version: 1,
            updatedAt: new Date(),
          })
          .mockResolvedValueOnce({
            id: 'c1',
            number: 'C-1',
            name: '客户',
            status: 'ACTIVE',
            version: 1,
            updatedAt: new Date(),
            contacts: [{ id: 'ct1', customerId: 'c1', name: '联系人' }],
          }),
      },
    };
    const access = {
      resolveProjectScope: vi.fn().mockResolvedValue(['p1']),
      listProjectRoles: vi.fn().mockResolvedValue(['PROJECT_MANAGER']),
    };
    const service = new CustomersService(prisma as never, access as never, projectManage as never);

    await expect(service.get('u1', 'c1')).resolves.toMatchObject({
      contacts: [{ customerId: 'c1' }],
    });
    expect(prisma.customer.findFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          contacts: expect.objectContaining({
            select: expect.objectContaining({ customerId: true }),
          }),
        }),
      }),
    );
  });

  it('returns 404 before contact lookup when the parent customer is outside project scope', async () => {
    const prisma = {
      customer: { findFirst: vi.fn().mockResolvedValue(null) },
      customerContact: { findMany: vi.fn() },
    };
    const access = {
      resolveProjectScope: vi.fn().mockResolvedValue(['p1']),
      listProjectRoles: vi.fn().mockResolvedValue(['MEMBER']),
    };
    const service = new CustomersService(prisma as never, access as never, projectManage as never);

    await expect(service.listContacts('u1', 'c-other')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.customerContact.findMany).not.toHaveBeenCalled();
  });

  it.each(['create', 'update', 'archive'] as const)(
    'bounds Serializable retries for contact %s and maps P2034 exhaustion to conflict',
    async (operation) => {
      const conflict = Object.assign(new Error('write conflict'), { code: 'P2034' });
      const tx = {
        customer: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        customerContact: {
          findFirst: vi.fn().mockResolvedValue({ id: 'ct1' }),
          create: vi.fn().mockResolvedValue({ id: 'ct1' }),
          update: vi.fn().mockResolvedValue({ id: 'ct1' }),
        },
      };
      const prisma = {
        customer: { findFirst: vi.fn().mockResolvedValue({ id: 'c1' }) },
        $transaction: vi.fn(
          async (callback: (value: typeof tx) => unknown, options: { isolationLevel: string }) => {
            expect(options).toEqual({ isolationLevel: 'Serializable' });
            await callback(tx);
            throw conflict;
          },
        ),
      };
      const access = {
        resolveProjectScope: vi.fn().mockResolvedValue(['p1']),
        listProjectRoles: vi.fn().mockResolvedValue(['PROJECT_MANAGER']),
      };
      const service = new CustomersService(
        prisma as never,
        access as never,
        projectManage as never,
      );

      const result =
        operation === 'create'
          ? service.createContact('u1', 'c1', { version: 1, name: '联系人' })
          : operation === 'update'
            ? service.updateContact('u1', 'c1', 'ct1', { version: 1, name: '联系人' })
            : service.archiveContact('u1', 'c1', 'ct1', 1);

      await expect(result).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.$transaction).toHaveBeenCalledTimes(3);
      for (const call of prisma.$transaction.mock.calls) {
        expect(call[1]).toEqual({ isolationLevel: 'Serializable' });
      }
    },
  );
});
