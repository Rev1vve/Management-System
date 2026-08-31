import { ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { PrismaClient } from '../../src/generated/prisma/client';
import { ProjectsService } from '../../src/modules/projects/projects.service';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for integration tests');

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

async function truncateAll(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "project_membership_roles", "project_memberships", "projects", "user_system_roles", "role_permissions", "permissions", "system_roles", "users" RESTART IDENTITY CASCADE',
  );
}

async function createManager(account: string, projectId: string): Promise<{ id: string }> {
  const user = await prisma.user.create({
    data: { account, name: account, workEmail: `${account}@example.test`, status: 'ACTIVE' },
    select: { id: true },
  });
  const role = await prisma.systemRole.create({
    data: { key: `PROJECT_MANAGER_${account}`, name: account, requiresMfa: false },
    select: { id: true },
  });
  const permission = await prisma.permission.upsert({
    where: { key: 'project:manage' },
    update: {},
    create: { key: 'project:manage', description: 'project:manage' },
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

describe('ProjectsService final manager concurrency', () => {
  beforeAll(async () => prisma.$connect());
  beforeEach(async () => truncateAll());
  afterAll(async () => prisma.$disconnect());

  it('allows only one concurrent manager removal/demotion and keeps one manager', async () => {
    const project = await prisma.project.create({
      data: { number: 'PRJ-MANAGER-RACE', name: '经理并发保护' },
      select: { id: true },
    });
    const managerA = await createManager('manager-race-a', project.id);
    const managerB = await createManager('manager-race-b', project.id);
    const service = new ProjectsService(
      prisma as never,
      { assertProjectRole: vi.fn().mockResolvedValue(undefined) } as never,
      { listUserPermissions: vi.fn().mockResolvedValue(['project:manage']) } as never,
    );

    const results = await Promise.allSettled([
      service.removeMember(managerA.id, project.id, managerA.id),
      service.replaceMemberRoles(managerA.id, project.id, managerB.id, ['MEMBER']),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(rejected).toHaveLength(1);
    expect(
      rejected[0]?.reason instanceof ConflictException ||
        rejected[0]?.reason instanceof NotFoundException,
    ).toBe(true);
    await expect(
      prisma.projectMembership.count({
        where: { projectId: project.id, roles: { some: { role: 'PROJECT_MANAGER' } } },
      }),
    ).resolves.toBe(1);
  });
});
