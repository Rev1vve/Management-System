import { ConflictException } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { PrismaClient } from '../../src/generated/prisma/client';
import { CustomersService } from '../../src/modules/customers/customers.service';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for integration tests');

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

async function truncateAll(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "projects", "customers", "user_system_roles", "role_permissions", "permissions", "system_roles", "users" RESTART IDENTITY CASCADE',
  );
}

async function createProjectManager(projectId: string): Promise<{ id: string }> {
  const user = await prisma.user.create({
    data: {
      account: 'customer-race-manager',
      name: 'customer-race-manager',
      workEmail: 'customer-race-manager@example.test',
      status: 'ACTIVE',
    },
    select: { id: true },
  });
  const role = await prisma.systemRole.create({
    data: { key: 'CUSTOMER_RACE_MANAGER', name: 'Customer race manager', requiresMfa: false },
    select: { id: true },
  });
  const permission = await prisma.permission.create({
    data: { key: 'project:manage', description: 'project:manage' },
    select: { id: true },
  });
  await prisma.rolePermission.create({
    data: { systemRoleId: role.id, permissionId: permission.id },
  });
  await prisma.userSystemRole.create({ data: { userId: user.id, systemRoleId: role.id } });
  await prisma.projectMembership.create({
    data: { userId: user.id, projectId, roles: { create: [{ role: 'PROJECT_MANAGER' }] } },
  });
  return user;
}

describe('CustomersService customer binding concurrency', () => {
  beforeAll(async () => prisma.$connect());
  beforeEach(async () => truncateAll());
  afterAll(async () => prisma.$disconnect());

  it('allows one concurrent customer creation and rolls back the losing customer', async () => {
    const project = await prisma.project.create({
      data: { number: 'PRJ-CUSTOMER-RACE', name: '客户绑定并发保护', status: 'ACTIVE' },
      select: { id: true },
    });
    const manager = await createProjectManager(project.id);
    const service = new CustomersService(
      prisma as never,
      { assertProjectRole: vi.fn().mockResolvedValue(undefined) } as never,
      { listUserPermissions: vi.fn().mockResolvedValue(['project:manage']) } as never,
    );

    const results = await Promise.allSettled([
      service.create(manager.id, {
        projectId: project.id,
        number: 'CUSTOMER-RACE-A',
        name: '并发客户 A',
      }),
      service.create(manager.id, {
        projectId: project.id,
        number: 'CUSTOMER-RACE-B',
        name: '并发客户 B',
      }),
    ]);

    type CreatedCustomer = Awaited<ReturnType<CustomersService['create']>>;
    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<CreatedCustomer> => result.status === 'fulfilled',
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(ConflictException);
    const winner = fulfilled[0];
    if (!winner) throw new Error('expected one winning customer creation');

    const storedProject = await prisma.project.findUniqueOrThrow({
      where: { id: project.id },
      select: { customerId: true },
    });
    expect(storedProject.customerId).toBe(winner.value.id);
    await expect(prisma.customer.count()).resolves.toBe(1);
  });
});
