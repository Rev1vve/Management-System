import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PrismaService } from '../../src/database/prisma.service';
import { ProjectAccessService } from '../../src/modules/project-access/project-access.service';
import type { ProjectRole } from '../../src/generated/prisma/client';

/**
 * Integration tests for project-scope enforcement (plan task 6):
 * membership checks, anti-enumeration 404s, project-role assertions and
 * immediate revocation. Requires a real PostgreSQL on the private Compose
 * network.
 */
const prisma = new PrismaService();

const TABLES = [
  'project_membership_roles',
  'project_memberships',
  'projects',
  'portfolios',
  'customers',
  'users',
];

async function truncateAll(): Promise<void> {
  const joined = TABLES.map((t) => `"${t}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${joined} RESTART IDENTITY CASCADE`);
}

let service: ProjectAccessService;

beforeAll(async () => {
  service = new ProjectAccessService(prisma);
});

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function createUser(account: string): Promise<string> {
  const user = await prisma.user.create({
    data: {
      account,
      name: account,
      workEmail: `${account}@example.test`,
      status: 'ACTIVE',
    },
  });
  return user.id;
}

async function createProject(number = 'PRJ-0001'): Promise<string> {
  const project = await prisma.project.create({
    data: { number, name: `项目 ${number}`, status: 'ACTIVE' },
  });
  return project.id;
}

async function addMember(userId: string, projectId: string, roles: ProjectRole[]): Promise<void> {
  const membership = await prisma.projectMembership.create({
    data: { userId, projectId },
  });
  for (const role of roles) {
    await prisma.projectMembershipRole.create({
      data: { membershipId: membership.id, role },
    });
  }
}

describe('ProjectAccessService (integration)', () => {
  it('resolves roles for a member; asserts access resolves the same set', async () => {
    const userId = await createUser('member1');
    const projectId = await createProject();
    await addMember(userId, projectId, ['MEMBER', 'APPROVER']);

    await expect(service.listProjectRoles(userId, projectId)).resolves.toEqual([
      'MEMBER',
      'APPROVER',
    ]);
    await expect(service.assertProjectAccess(userId, projectId)).resolves.toEqual({
      roles: ['MEMBER', 'APPROVER'],
    });
  });

  it('returns [] roles and false for a non-member', async () => {
    const userId = await createUser('outsider');
    const projectId = await createProject();

    await expect(service.listProjectRoles(userId, projectId)).resolves.toEqual([]);
    await expect(service.isProjectMember(userId, projectId)).resolves.toBe(false);
  });

  it('throws 404 for a missing project', async () => {
    const userId = await createUser('anyone');

    await expect(service.assertProjectAccess(userId, 'no-such-project')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('throws 404 for a non-member: identical response to a missing project', async () => {
    const userId = await createUser('outsider');
    const projectId = await createProject();

    const missing = await service
      .assertProjectAccess(userId, 'no-such-project')
      .catch((e: unknown) => e);
    const noAccess = await service.assertProjectAccess(userId, projectId).catch((e: unknown) => e);

    expect(missing).toBeInstanceOf(NotFoundException);
    expect(noAccess).toBeInstanceOf(NotFoundException);
    // Same status code AND same message: existence must not leak.
    expect((missing as NotFoundException).message).toBe((noAccess as NotFoundException).message);
  });

  it('allows assertProjectRole when the user holds a required project role', async () => {
    const userId = await createUser('pm');
    const projectId = await createProject();
    await addMember(userId, projectId, ['PROJECT_MANAGER']);

    await expect(
      service.assertProjectRole(userId, projectId, ['PROJECT_MANAGER']),
    ).resolves.toBeUndefined();
  });

  it('rejects 403 when the user is a member but lacks every required role', async () => {
    const userId = await createUser('member2');
    const projectId = await createProject();
    await addMember(userId, projectId, ['MEMBER']);

    await expect(
      service.assertProjectRole(userId, projectId, ['PROJECT_MANAGER']),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects a non-member with 404 (not 403) on role assertions', async () => {
    const userId = await createUser('outsider2');
    const projectId = await createProject();

    await expect(service.assertProjectRole(userId, projectId, ['MEMBER'])).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('removes access immediately when the membership is deleted (no cache)', async () => {
    const userId = await createUser('temp');
    const projectId = await createProject();
    await addMember(userId, projectId, ['MEMBER']);

    await expect(service.assertProjectAccess(userId, projectId)).resolves.toEqual({
      roles: ['MEMBER'],
    });

    const membership = await prisma.projectMembership.findUniqueOrThrow({
      where: { userId_projectId: { userId, projectId } },
      select: { id: true },
    });

    // Membership removed (e.g. by a manager): the project-role rows carry a
    // foreign key to the membership, so a real removal deletes them first,
    // then the membership. The very next access check must fail.
    await prisma.projectMembershipRole.deleteMany({
      where: { membershipId: membership.id },
    });
    await prisma.projectMembership.delete({
      where: { userId_projectId: { userId, projectId } },
    });

    await expect(service.assertProjectAccess(userId, projectId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.isProjectMember(userId, projectId)).resolves.toBe(false);
  });

  it('resolveProjectScope returns exactly the projects the user belongs to', async () => {
    const userId = await createUser('scoped');
    const p1 = await createProject('PRJ-0001');
    const p2 = await createProject('PRJ-0002');
    await createProject('PRJ-0003'); // not a member
    await addMember(userId, p1, ['MEMBER']);
    await addMember(userId, p2, ['MEMBER']);

    await expect(service.resolveProjectScope(userId)).resolves.toEqual(
      expect.arrayContaining([p1, p2]),
    );
    const scope = await service.resolveProjectScope(userId);
    expect(scope).toHaveLength(2);
  });
});
