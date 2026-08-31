import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { OrdersService } from './orders.service';

const projectManage = { listUserPermissions: vi.fn().mockResolvedValue(['project:manage']) };

describe('OrdersService', () => {
  it('reads an order only after authorizing its parent project', async () => {
    const prisma = {
      order: { findFirst: vi.fn().mockResolvedValue({ id: 'o1', projectId: 'p1', title: '订单' }) },
    };
    const access = { assertProjectAccess: vi.fn().mockResolvedValue({ roles: ['MEMBER'] }) };
    const service = new OrdersService(prisma as never, access as never, projectManage as never);
    await service.get('u1', 'p1', 'o1');
    expect(access.assertProjectAccess).toHaveBeenCalledWith('u1', 'p1');
    expect(prisma.order.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'o1',
          projectId: 'p1',
          status: { not: 'ARCHIVED' },
          deletedAt: null,
          project: {
            status: { not: 'ARCHIVED' },
            deletedAt: null,
            memberships: { some: { userId: 'u1', user: { status: 'ACTIVE', deletedAt: null } } },
          },
        },
      }),
    );
  });

  it('cannot re-expose archived orders through an explicit status query', async () => {
    const prisma = {
      order: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
    };
    const access = { assertProjectAccess: vi.fn().mockResolvedValue({ roles: ['MEMBER'] }) };
    const service = new OrdersService(prisma as never, access as never, projectManage as never);

    await service.list('u1', 'p1', { page: 1, pageSize: 20, status: 'ARCHIVED' });

    expect(prisma.order.count).toHaveBeenCalledWith({
      where: {
        projectId: 'p1',
        deletedAt: null,
        AND: [{ status: { not: 'ARCHIVED' } }, { status: 'ARCHIVED' }],
        project: {
          status: { not: 'ARCHIVED' },
          deletedAt: null,
          memberships: { some: { userId: 'u1', user: { status: 'ACTIVE', deletedAt: null } } },
        },
      },
    });
  });

  it('advertises order creation only for project managers with project:manage', async () => {
    const prisma = {
      order: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
    };
    const access = {
      assertProjectAccess: vi.fn().mockResolvedValue({ roles: ['PROJECT_MANAGER'] }),
    };
    const roles = { listUserPermissions: vi.fn().mockResolvedValue(['project:manage']) };
    const service = new OrdersService(prisma as never, access as never, roles as never);

    await expect(service.list('u1', 'p1', { page: 1, pageSize: 20 })).resolves.toMatchObject({
      canManage: true,
    });
  });

  it('rejects an order item whose order is outside the routed project', async () => {
    const prisma = { orderItem: { findFirst: vi.fn().mockResolvedValue(null) } };
    const access = { assertProjectAccess: vi.fn().mockResolvedValue({ roles: ['MEMBER'] }) };
    const service = new OrdersService(prisma as never, access as never, projectManage as never);
    await expect(service.getItem('u1', 'p1', 'o1', 'i1')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.orderItem.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          order: expect.objectContaining({
            projectId: 'p1',
            status: { not: 'ARCHIVED' },
            deletedAt: null,
            project: expect.any(Object),
          }),
        }),
      }),
    );
  });

  it('rechecks the active parent order while listing items', async () => {
    const prisma = {
      order: { findFirst: vi.fn().mockResolvedValue({ id: 'o1', projectId: 'p1' }) },
      orderItem: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const access = { assertProjectAccess: vi.fn().mockResolvedValue({ roles: ['MEMBER'] }) };
    const service = new OrdersService(prisma as never, access as never, projectManage as never);

    await service.listItems('u1', 'p1', 'o1');

    expect(prisma.orderItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          orderId: 'o1',
          order: expect.objectContaining({
            projectId: 'p1',
            status: { not: 'ARCHIVED' },
            deletedAt: null,
            project: expect.any(Object),
          }),
        }),
      }),
    );
  });

  it('rechecks current active project membership in the final item list query', async () => {
    const prisma = {
      order: { findFirst: vi.fn().mockResolvedValue({ id: 'o1', projectId: 'p1' }) },
      orderItem: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const access = { assertProjectAccess: vi.fn().mockResolvedValue({ roles: ['MEMBER'] }) };
    const service = new OrdersService(prisma as never, access as never, projectManage as never);

    await service.listItems('u1', 'p1', 'o1');

    expect(prisma.orderItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          order: expect.objectContaining({
            project: {
              status: { not: 'ARCHIVED' },
              deletedAt: null,
              memberships: {
                some: { userId: 'u1', user: { status: 'ACTIVE', deletedAt: null } },
              },
            },
          }),
        }),
      }),
    );
  });

  it.each(['create', 'update', 'remove'] as const)(
    'rechecks active project manager membership in the final %s item write predicate',
    async (operation) => {
      const tx = {
        order: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        orderItem: {
          findFirst: vi.fn().mockResolvedValue({
            id: 'i1',
            status: 'PENDING',
            plannedDate: null,
            completedDate: null,
          }),
          create: vi.fn().mockResolvedValue({ id: 'i1' }),
          update: vi.fn().mockResolvedValue({ id: 'i1' }),
        },
      };
      const prisma = {
        $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)),
      };
      const access = { assertProjectRole: vi.fn().mockResolvedValue(undefined) };
      const service = new OrdersService(prisma as never, access as never, projectManage as never);

      if (operation === 'create') {
        await service.createItem('u1', 'p1', 'o1', { version: 1, name: '实施', quantity: 1 });
      } else if (operation === 'update') {
        await service.updateItem('u1', 'p1', 'o1', 'i1', { version: 1, name: '实施' });
      } else {
        await service.removeItem('u1', 'p1', 'o1', 'i1', 1);
      }

      expect(tx.order.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            project: {
              status: { not: 'ARCHIVED' },
              deletedAt: null,
              memberships: {
                some: expect.objectContaining({
                  userId: 'u1',
                  roles: { some: { role: 'PROJECT_MANAGER' } },
                }),
              },
            },
          }),
        }),
      );
      expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
        isolationLevel: 'Serializable',
      });
    },
  );

  it('retries the complete OrderItem serializable transaction after P2034', async () => {
    const conflict = Object.assign(new Error('write conflict'), { code: 'P2034' });
    const tx = {
      order: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findFirst: vi.fn().mockResolvedValue({ id: 'o1' }),
      },
      orderItem: { create: vi.fn().mockResolvedValue({ id: 'i1' }) },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => {
        const result = await callback(tx);
        if (prisma.$transaction.mock.calls.length === 1) throw conflict;
        return result;
      }),
    };
    const access = { assertProjectRole: vi.fn().mockResolvedValue(undefined) };
    const service = new OrdersService(prisma as never, access as never, projectManage as never);

    await expect(
      service.createItem('u1', 'p1', 'o1', { version: 1, name: '实施', quantity: 1 }),
    ).resolves.toEqual({ id: 'i1' });

    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(tx.order.updateMany).toHaveBeenCalledTimes(2);
    expect(tx.orderItem.create).toHaveBeenCalledTimes(2);
  });

  it('bounds P2034 retries and returns a stable conflict after exhaustion', async () => {
    const conflict = Object.assign(new Error('write conflict'), { code: 'P2034' });
    const tx = {
      order: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      orderItem: { create: vi.fn().mockResolvedValue({ id: 'i1' }) },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => {
        await callback(tx);
        throw conflict;
      }),
    };
    const access = { assertProjectRole: vi.fn().mockResolvedValue(undefined) };
    const service = new OrdersService(prisma as never, access as never, projectManage as never);

    await expect(
      service.createItem('u1', 'p1', 'o1', { version: 1, name: '实施', quantity: 1 }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.$transaction).toHaveBeenCalledTimes(3);
  });

  it.each(['update', 'remove'] as const)(
    'returns not found when current authorization disappears during an item %s write',
    async (operation) => {
      const tx = {
        order: {
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
          findFirst: vi.fn().mockResolvedValue(null),
        },
        orderItem: {
          findFirst: vi.fn().mockResolvedValue({ id: 'i1' }),
          update: vi.fn(),
        },
      };
      const prisma = {
        $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)),
      };
      const access = { assertProjectRole: vi.fn().mockResolvedValue(undefined) };
      const service = new OrdersService(prisma as never, access as never, projectManage as never);

      const result =
        operation === 'update'
          ? service.updateItem('u1', 'p1', 'o1', 'i1', { version: 1, name: '更新' })
          : service.removeItem('u1', 'p1', 'o1', 'i1', 1);

      await expect(result).rejects.toBeInstanceOf(NotFoundException);
      expect(tx.order.findFirst).toHaveBeenCalledTimes(2);
      expect(tx.order.findFirst.mock.calls[1]?.[0]).toEqual({
        where: {
          id: 'o1',
          projectId: 'p1',
          project: {
            status: { not: 'ARCHIVED' },
            deletedAt: null,
            memberships: {
              some: { userId: 'u1', user: { status: 'ACTIVE', deletedAt: null } },
            },
          },
          status: { not: 'ARCHIVED' },
          deletedAt: null,
          items: { some: { id: 'i1' } },
        },
        select: { id: true },
      });
      expect(tx.orderItem.update).not.toHaveBeenCalled();
    },
  );

  it.each(['update', 'remove'] as const)(
    'returns forbidden when an existing item loses manager authorization before the final item %s lookup',
    async (operation) => {
      const tx = {
        order: {
          findFirst: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'o1' }),
          updateMany: vi.fn(),
        },
        orderItem: {
          findFirst: vi.fn().mockResolvedValue(null),
          update: vi.fn(),
        },
      };
      const prisma = {
        $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)),
      };
      const access = { assertProjectRole: vi.fn().mockResolvedValue(undefined) };
      const service = new OrdersService(prisma as never, access as never, projectManage as never);

      const result =
        operation === 'update'
          ? service.updateItem('u1', 'p1', 'o1', 'i1', { version: 1, name: '更新' })
          : service.removeItem('u1', 'p1', 'o1', 'i1', 1);

      await expect(result).rejects.toBeInstanceOf(ForbiddenException);
      expect(tx.order.updateMany).not.toHaveBeenCalled();
      expect(tx.orderItem.update).not.toHaveBeenCalled();
    },
  );

  it.each(['create', 'update', 'remove'] as const)(
    'returns forbidden when a visible order loses final manager authorization during an item %s write',
    async (operation) => {
      const tx = {
        order: {
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
          findFirst: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'o1' }),
        },
        orderItem: {
          findFirst: vi.fn().mockResolvedValue({ id: 'i1' }),
          create: vi.fn(),
          update: vi.fn(),
        },
      };
      const prisma = {
        $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)),
      };
      const access = { assertProjectRole: vi.fn().mockResolvedValue(undefined) };
      const service = new OrdersService(prisma as never, access as never, projectManage as never);

      const result =
        operation === 'create'
          ? service.createItem('u1', 'p1', 'o1', { version: 1, name: '新项' })
          : operation === 'update'
            ? service.updateItem('u1', 'p1', 'o1', 'i1', { version: 1, name: '更新' })
            : service.removeItem('u1', 'p1', 'o1', 'i1', 1);

      await expect(result).rejects.toBeInstanceOf(ForbiddenException);
      expect(tx.orderItem.create).not.toHaveBeenCalled();
      expect(tx.orderItem.update).not.toHaveBeenCalled();
    },
  );

  it.each(['update', 'remove'] as const)(
    'returns conflict for a stale parent version during an authorized item %s write',
    async (operation) => {
      const tx = {
        order: {
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
          findFirst: vi.fn().mockResolvedValue({ id: 'o1' }),
        },
        orderItem: {
          findFirst: vi.fn().mockResolvedValue({ id: 'i1' }),
          update: vi.fn(),
        },
      };
      const prisma = {
        $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)),
      };
      const access = { assertProjectRole: vi.fn().mockResolvedValue(undefined) };
      const service = new OrdersService(prisma as never, access as never, projectManage as never);

      const result =
        operation === 'update'
          ? service.updateItem('u1', 'p1', 'o1', 'i1', { version: 1, name: '更新' })
          : service.removeItem('u1', 'p1', 'o1', 'i1', 1);

      await expect(result).rejects.toBeInstanceOf(ConflictException);
      expect(tx.order.findFirst).toHaveBeenCalledOnce();
      expect(tx.orderItem.update).not.toHaveBeenCalled();
    },
  );

  it('cancels an order item without physically deleting its historical row', async () => {
    const tx = {
      order: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      orderItem: {
        findFirst: vi.fn().mockResolvedValue({ id: 'i1' }),
        update: vi.fn().mockResolvedValue({ id: 'i1', status: 'CANCELLED' }),
        delete: vi.fn(),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)),
    };
    const access = { assertProjectRole: vi.fn().mockResolvedValue(undefined) };
    const service = new OrdersService(prisma as never, access as never, projectManage as never);
    await service.removeItem('u1', 'p1', 'o1', 'i1', 1);
    expect(tx.orderItem.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'CANCELLED' } }),
    );
    expect(tx.orderItem.delete).not.toHaveBeenCalled();
  });

  it('uses an atomic order version predicate and returns conflict for stale writes', async () => {
    const prisma = {
      order: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        findFirst: vi
          .fn()
          .mockResolvedValue({ id: 'o1', status: 'DRAFT', startDate: null, deliveryDate: null }),
      },
    };
    const access = { assertProjectRole: vi.fn().mockResolvedValue(undefined) };
    const service = new OrdersService(prisma as never, access as never, projectManage as never);
    await expect(
      service.update('u1', 'p1', 'o1', { version: 1, title: 'new' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('only allows a new order to start in DRAFT', async () => {
    const service = new OrdersService({} as never, {} as never, projectManage as never);

    for (const status of ['ACTIVE', 'COMPLETED', 'CANCELLED', 'ARCHIVED']) {
      await expect(
        service.create('u1', 'p1', { number: 'O1', title: '订单', status }),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
  });

  it('writes DRAFT explicitly when a new order omits status', async () => {
    const tx = {
      project: { findFirst: vi.fn().mockResolvedValue({ id: 'p1' }) },
      order: { create: vi.fn().mockResolvedValue({ id: 'o1', status: 'DRAFT' }) },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)),
    };
    const access = { assertProjectRole: vi.fn().mockResolvedValue(undefined) };
    const service = new OrdersService(prisma as never, access as never, projectManage as never);

    await service.create('u1', 'p1', { number: 'O1', title: '订单' });

    expect(tx.order.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { number: 'O1', title: '订单', status: 'DRAFT', projectId: 'p1' },
      }),
    );
  });

  it('rejects direct ARCHIVED updates so only the archive command can soft-delete an order', async () => {
    const service = new OrdersService({} as never, {} as never, projectManage as never);
    await expect(
      service.update('u1', 'p1', 'o1', { version: 1, status: 'ARCHIVED' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects invalid order state transitions and merged date ranges', async () => {
    const existing = {
      id: 'o1',
      status: 'ACTIVE',
      startDate: new Date('2026-08-20'),
      deliveryDate: new Date('2026-08-30'),
    };
    const prisma = {
      order: { findFirst: vi.fn().mockResolvedValue(existing), updateMany: vi.fn() },
    };
    const access = { assertProjectRole: vi.fn().mockResolvedValue(undefined) };
    const service = new OrdersService(prisma as never, access as never, projectManage as never);

    await expect(
      service.update('u1', 'p1', 'o1', { version: 1, status: 'DRAFT' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.update('u1', 'p1', 'o1', { version: 1, startDate: new Date('2026-09-01') }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
  });

  it('requires the parent order version and advances it atomically before creating an item', async () => {
    const created = { id: 'i1', orderId: 'o1', name: '实施', quantity: 1, status: 'PENDING' };
    const tx = {
      order: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      orderItem: { create: vi.fn().mockResolvedValue(created) },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)),
    };
    const access = { assertProjectRole: vi.fn().mockResolvedValue(undefined) };
    const service = new OrdersService(prisma as never, access as never, projectManage as never);

    await expect(
      service.createItem('u1', 'p1', 'o1', { version: 3, name: '实施', quantity: 1 }),
    ).resolves.toEqual(created);
    expect(tx.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'o1',
          projectId: 'p1',
          version: 3,
          status: { not: 'ARCHIVED' },
          deletedAt: null,
          project: expect.any(Object),
        }),
        data: { version: { increment: 1 } },
      }),
    );
    expect(tx.orderItem.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ orderId: 'o1', name: '实施' }),
      }),
    );
  });

  it('advances the parent order version atomically before updating an item', async () => {
    const updatedItem = {
      id: 'i1',
      orderId: 'o1',
      name: '更新实施',
      quantity: 1,
      status: 'IN_PROGRESS',
    };
    const tx = {
      order: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      orderItem: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'i1',
          status: 'PENDING',
          plannedDate: null,
          completedDate: null,
        }),
        update: vi.fn().mockResolvedValue(updatedItem),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)),
    };
    const access = { assertProjectRole: vi.fn().mockResolvedValue(undefined) };
    const service = new OrdersService(prisma as never, access as never, projectManage as never);

    await expect(
      service.updateItem('u1', 'p1', 'o1', 'i1', {
        version: 4,
        name: '更新实施',
        status: 'IN_PROGRESS',
      }),
    ).resolves.toEqual(updatedItem);
    expect(tx.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'o1',
          projectId: 'p1',
          version: 4,
          status: { not: 'ARCHIVED' },
          deletedAt: null,
          project: expect.any(Object),
        }),
        data: { version: { increment: 1 } },
      }),
    );
    expect(tx.orderItem.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'i1' } }),
    );
  });

  it('advances the parent order version atomically before cancelling an item', async () => {
    const tx = {
      order: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      orderItem: {
        findFirst: vi.fn().mockResolvedValue({ id: 'i1' }),
        update: vi.fn().mockResolvedValue({ id: 'i1', status: 'CANCELLED' }),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)),
    };
    const access = { assertProjectRole: vi.fn().mockResolvedValue(undefined) };
    const service = new OrdersService(prisma as never, access as never, projectManage as never);

    await expect(service.removeItem('u1', 'p1', 'o1', 'i1', 5)).resolves.toEqual({ ok: true });
    expect(tx.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'o1',
          projectId: 'p1',
          version: 5,
          status: { not: 'ARCHIVED' },
          deletedAt: null,
          project: expect.any(Object),
        }),
        data: { version: { increment: 1 } },
      }),
    );
    expect(tx.orderItem.update).toHaveBeenCalledWith({
      where: { id: 'i1' },
      data: { status: 'CANCELLED' },
    });
  });

  it('fails closed on unknown service-layer order and item fields', async () => {
    const access = { assertProjectRole: vi.fn().mockResolvedValue(undefined) };
    const service = new OrdersService({} as never, access as never, projectManage as never);
    await expect(
      service.create('u1', 'p1', { number: 'O1', title: 'x', projectId: 'p2' } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.updateItem('u1', 'p1', 'o1', 'i1', { orderId: 'other' } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('returns an explicit write capability only when project role and system permission both allow it', async () => {
    const detail = { id: 'o1', projectId: 'p1', title: '订单', version: 1 };
    const prisma = { order: { findFirst: vi.fn().mockResolvedValue(detail) } };
    const access = {
      assertProjectAccess: vi.fn().mockResolvedValue({ roles: ['PROJECT_MANAGER'] }),
    };
    const roles = { listUserPermissions: vi.fn().mockResolvedValue(['project:manage']) };
    const service = new OrdersService(prisma as never, access as never, roles as never);

    await expect(service.get('u1', 'p1', 'o1')).resolves.toEqual({ ...detail, canManage: true });
  });

  it('denies service-layer writes without project:manage before project role checks', async () => {
    const access = { assertProjectRole: vi.fn() };
    const roles = { listUserPermissions: vi.fn().mockResolvedValue([]) };
    const service = new OrdersService({} as never, access as never, roles as never);

    await expect(
      service.create('u1', 'p1', { number: 'O1', title: '订单' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(access.assertProjectRole).not.toHaveBeenCalled();
  });

  it('creates an order only after a serializable current-manager check', async () => {
    const tx = {
      project: { findFirst: vi.fn().mockResolvedValue({ id: 'p1' }) },
      order: { create: vi.fn().mockResolvedValue({ id: 'o1' }) },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)),
    };
    const access = { assertProjectRole: vi.fn().mockResolvedValue(undefined) };
    const service = new OrdersService(prisma as never, access as never, projectManage as never);

    await service.create('u1', 'p1', { number: 'O1', title: '订单' });

    expect(tx.project.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'p1',
          memberships: {
            some: expect.objectContaining({
              userId: 'u1',
              roles: { some: { role: 'PROJECT_MANAGER' } },
              user: expect.objectContaining({ status: 'ACTIVE', deletedAt: null }),
            }),
          },
        }),
      }),
    );
    expect(tx.order.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { number: 'O1', title: '订单', status: 'DRAFT', projectId: 'p1' },
      }),
    );
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'Serializable',
    });
  });

  it.each(['update', 'archive'] as const)(
    'rechecks current manager membership and project:manage in the final order %s predicate',
    async (operation) => {
      const prisma = {
        order: {
          findFirst: vi.fn().mockResolvedValue({
            id: 'o1',
            status: 'DRAFT',
            startDate: null,
            deliveryDate: null,
          }),
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
      };
      const access = { assertProjectRole: vi.fn().mockResolvedValue(undefined) };
      const service = new OrdersService(prisma as never, access as never, projectManage as never);

      const result =
        operation === 'update'
          ? service.update('u1', 'p1', 'o1', { version: 1, title: 'new' })
          : service.archive('u1', 'p1', 'o1', 1);
      await expect(result).rejects.toBeDefined();

      expect(prisma.order.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            project: expect.objectContaining({
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
          }),
        }),
      );
    },
  );
});
