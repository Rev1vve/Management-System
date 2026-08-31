import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { PrismaClient } from '../../src/generated/prisma/client';
import { OrdersService } from '../../src/modules/orders/orders.service';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for integration tests');

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

async function truncateAll(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "order_items", "orders", "project_membership_roles", "project_memberships", "projects", "user_system_roles", "role_permissions", "permissions", "system_roles", "users" RESTART IDENTITY CASCADE',
  );
}

async function createManager(account: string) {
  const user = await prisma.user.create({
    data: { account, name: account, workEmail: `${account}@example.test`, status: 'ACTIVE' },
  });
  const role = await prisma.systemRole.create({
    data: { key: 'PROJECT_MANAGER', name: '测试项目经理', requiresMfa: false },
  });
  const permission = await prisma.permission.create({
    data: { key: 'project:manage', description: 'project:manage' },
  });
  await prisma.rolePermission.create({
    data: { systemRoleId: role.id, permissionId: permission.id },
  });
  await prisma.userSystemRole.create({ data: { userId: user.id, systemRoleId: role.id } });
  return user;
}

async function createScopedOrder(account: string) {
  const manager = await createManager(account);
  const project = await prisma.project.create({
    data: { number: `${account}-project`, name: `${account} project`, status: 'ACTIVE' },
  });
  const membership = await prisma.projectMembership.create({
    data: {
      userId: manager.id,
      projectId: project.id,
      roles: { create: [{ role: 'PROJECT_MANAGER' }] },
    },
  });
  const order = await prisma.order.create({
    data: { number: `${account}-order`, title: `${account} order`, projectId: project.id },
  });
  return { manager, project, membership, order };
}

function service(access: {
  assertProjectRole: ReturnType<typeof vi.fn>;
  assertProjectAccess: ReturnType<typeof vi.fn>;
}) {
  return new OrdersService(
    prisma as never,
    access as never,
    { listUserPermissions: vi.fn().mockResolvedValue(['project:manage']) } as never,
  );
}

describe('OrdersService OrderItem concurrency', () => {
  beforeAll(async () => prisma.$connect());
  beforeEach(async () => truncateAll());
  afterAll(async () => prisma.$disconnect());

  it('fails reads and writes closed after project membership is revoked', async () => {
    const { manager, project, membership, order } = await createScopedOrder('order-item-revoke');
    const item = await prisma.orderItem.create({
      data: { orderId: order.id, name: 'original', quantity: 1 },
    });
    const access = {
      assertProjectAccess: vi.fn().mockResolvedValue({ roles: ['PROJECT_MANAGER'] }),
      assertProjectRole: vi.fn().mockImplementationOnce(async () => {
        await prisma.projectMembershipRole.deleteMany({ where: { membershipId: membership.id } });
        await prisma.projectMembership.delete({ where: { id: membership.id } });
      }),
    };
    const orders = service(access);

    await expect(
      orders.updateItem(manager.id, project.id, order.id, item.id, {
        version: order.version,
        name: 'must not persist',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);

    access.assertProjectRole.mockResolvedValue(undefined);
    await expect(
      orders.removeItem(manager.id, project.id, order.id, item.id, order.version),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(orders.getItem(manager.id, project.id, order.id, item.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(orders.listItems(manager.id, project.id, order.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );

    await expect(
      prisma.order.findUniqueOrThrow({ where: { id: order.id } }),
    ).resolves.toMatchObject({
      version: order.version,
    });
    await expect(prisma.orderItem.findMany({ where: { orderId: order.id } })).resolves.toEqual([
      expect.objectContaining({ id: item.id, name: 'original', status: 'PENDING' }),
    ]);
  });

  it.each(['create', 'update', 'remove'] as const)(
    'returns forbidden when a visible order loses final manager authorization during item %s',
    async (operation) => {
      const { manager, project, membership, order } = await createScopedOrder(
        `order-item-forbidden-${operation}`,
      );
      const item = await prisma.orderItem.create({
        data: { orderId: order.id, name: 'original', quantity: 1 },
      });
      const originalTransaction = prisma.$transaction.bind(prisma);
      const transactionSpy = vi.spyOn(prisma, '$transaction');
      transactionSpy.mockImplementationOnce((async (
        ...args: Parameters<typeof originalTransaction>
      ) => {
        await prisma.projectMembershipRole.deleteMany({ where: { membershipId: membership.id } });
        return originalTransaction(...args);
      }) as never);
      const access = {
        assertProjectAccess: vi.fn().mockResolvedValue({ roles: ['PROJECT_MANAGER'] }),
        assertProjectRole: vi.fn().mockResolvedValue(undefined),
      };
      const orders = service(access);

      try {
        const result =
          operation === 'create'
            ? orders.createItem(manager.id, project.id, order.id, {
                version: order.version,
                name: 'must not persist',
                quantity: 1,
              })
            : operation === 'update'
              ? orders.updateItem(manager.id, project.id, order.id, item.id, {
                  version: order.version,
                  name: 'must not persist',
                })
              : orders.removeItem(manager.id, project.id, order.id, item.id, order.version);

        await expect(result).rejects.toBeInstanceOf(ForbiddenException);
        await expect(
          prisma.order.findUniqueOrThrow({ where: { id: order.id } }),
        ).resolves.toMatchObject({ version: order.version });
        await expect(
          prisma.orderItem.findUniqueOrThrow({ where: { id: item.id } }),
        ).resolves.toMatchObject({ name: 'original', status: 'PENDING' });
        await expect(prisma.orderItem.count({ where: { orderId: order.id } })).resolves.toBe(1);
      } finally {
        transactionSpy.mockRestore();
      }
    },
  );

  it('allows one concurrent parent-version write and returns a stable conflict for the other', async () => {
    const { manager, project, order } = await createScopedOrder('order-item-concurrent');
    const access = {
      assertProjectAccess: vi.fn().mockResolvedValue({ roles: ['PROJECT_MANAGER'] }),
      assertProjectRole: vi.fn().mockResolvedValue(undefined),
    };
    const orders = service(access);

    const results = await Promise.allSettled([
      orders.createItem(manager.id, project.id, order.id, {
        version: order.version,
        name: 'first',
        quantity: 1,
      }),
      orders.createItem(manager.id, project.id, order.id, {
        version: order.version,
        name: 'second',
        quantity: 1,
      }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(ConflictException);
    await expect(
      prisma.order.findUniqueOrThrow({ where: { id: order.id } }),
    ).resolves.toMatchObject({
      version: order.version + 1,
    });
    await expect(prisma.orderItem.count({ where: { orderId: order.id } })).resolves.toBe(1);
  });
});
