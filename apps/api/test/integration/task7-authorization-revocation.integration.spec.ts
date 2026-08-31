import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { PrismaClient } from '../../src/generated/prisma/client';
import { CustomersService } from '../../src/modules/customers/customers.service';
import { OrdersService } from '../../src/modules/orders/orders.service';
import { PortfoliosService } from '../../src/modules/portfolios/portfolios.service';
import { ProjectsService } from '../../src/modules/projects/projects.service';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for integration tests');

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

const TABLES = [
  'order_items',
  'orders',
  'customer_contacts',
  'project_membership_roles',
  'project_memberships',
  'portfolio_memberships',
  'projects',
  'portfolios',
  'customers',
  'role_permissions',
  'user_system_roles',
  'permissions',
  'system_roles',
  'users',
] as const;

async function truncateAll(): Promise<void> {
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${TABLES.map((table) => `"${table}"`).join(', ')} RESTART IDENTITY CASCADE`,
  );
}

async function createUser(account: string) {
  return prisma.user.create({
    data: { account, name: account, workEmail: `${account}@example.test`, status: 'ACTIVE' },
    select: { id: true },
  });
}

async function grantPermission(userId: string, key: 'project:manage' | 'portfolio:manage') {
  const role = await prisma.systemRole.create({
    data: { key: `${key}-${userId}`, name: key, requiresMfa: false },
    select: { id: true },
  });
  const permission = await prisma.permission.upsert({
    where: { key },
    update: {},
    create: { key, description: key },
    select: { id: true },
  });
  await prisma.rolePermission.create({
    data: { systemRoleId: role.id, permissionId: permission.id },
  });
  await prisma.userSystemRole.create({ data: { userId, systemRoleId: role.id } });
}

async function createProjectManager(account: string) {
  const user = await createUser(account);
  await grantPermission(user.id, 'project:manage');
  const project = await prisma.project.create({
    data: { number: `P-${account}`, name: account, status: 'ACTIVE' },
  });
  const membership = await prisma.projectMembership.create({
    data: {
      userId: user.id,
      projectId: project.id,
      roles: { create: [{ role: 'PROJECT_MANAGER' }] },
    },
    select: { id: true },
  });
  return { user, project, membership };
}

async function revokeSystemPermission(userId: string): Promise<void> {
  await prisma.userSystemRole.deleteMany({ where: { userId } });
}

async function revokeProjectMembership(membershipId: string): Promise<void> {
  await prisma.projectMembershipRole.deleteMany({ where: { membershipId } });
  await prisma.projectMembership.delete({ where: { id: membershipId } });
}

function projectRoles() {
  return { listUserPermissions: vi.fn().mockResolvedValue(['project:manage']) };
}

function projectAccess(afterPrecheck: () => Promise<void>) {
  return {
    assertProjectRole: vi.fn(async () => {
      await afterPrecheck();
    }),
    assertProjectAccess: vi.fn(async () => {
      await afterPrecheck();
      return { roles: ['PROJECT_MANAGER'] };
    }),
  };
}

describe('Task 7 final authorization predicates against real PostgreSQL', () => {
  beforeAll(async () => prisma.$connect());
  beforeEach(async () => truncateAll());
  afterAll(async () => prisma.$disconnect());

  it('rolls back project creation when project:manage is revoked after the precheck', async () => {
    const user = await createUser('project-create');
    await grantPermission(user.id, 'project:manage');
    const roles = {
      listUserPermissions: vi.fn(async () => {
        await revokeSystemPermission(user.id);
        return ['project:manage'];
      }),
    };
    const service = new ProjectsService(prisma as never, {} as never, roles as never);

    await expect(
      service.create(user.id, { number: 'P-revoked-create', name: 'forbidden' }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    await expect(prisma.project.count({ where: { number: 'P-revoked-create' } })).resolves.toBe(0);
    await expect(prisma.projectMembership.count({ where: { userId: user.id } })).resolves.toBe(0);
  });

  it('rejects a project customer reassignment when reference scope is revoked after lookup', async () => {
    const { user, project } = await createProjectManager('project-reference-update');
    const customer = await prisma.customer.create({
      data: { number: 'C-reference-update', name: 'reference customer' },
    });
    const referenceProject = await prisma.project.create({
      data: {
        number: 'P-reference-source',
        name: 'reference source',
        customerId: customer.id,
      },
    });
    const referenceMembership = await prisma.projectMembership.create({
      data: {
        userId: user.id,
        projectId: referenceProject.id,
        roles: { create: [{ role: 'MEMBER' }] },
      },
      select: { id: true },
    });
    const hookedPrisma = {
      ...prisma,
      $transaction: async <T>(
        work: Parameters<typeof prisma.$transaction>[0],
        options: Parameters<typeof prisma.$transaction>[1],
      ): Promise<T> => {
        await revokeProjectMembership(referenceMembership.id);
        return prisma.$transaction(work, options) as Promise<T>;
      },
    };
    const access = {
      assertProjectRole: vi.fn().mockResolvedValue(undefined),
      assertProjectAccess: vi.fn().mockResolvedValue({ roles: ['PROJECT_MANAGER'] }),
    };
    const service = new ProjectsService(
      hookedPrisma as never,
      access as never,
      projectRoles() as never,
    );

    await expect(
      service.update(user.id, project.id, {
        version: project.version,
        customerId: customer.id,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);

    await expect(
      prisma.project.findUniqueOrThrow({ where: { id: project.id }, select: { customerId: true } }),
    ).resolves.toEqual({ customerId: null });
  });

  it.each(['update', 'archive'] as const)(
    'rejects a project %s after system permission is revoked by the precheck boundary',
    async (operation) => {
      const { user, project } = await createProjectManager(`project-${operation}`);
      const access = projectAccess(() => revokeSystemPermission(user.id));
      const service = new ProjectsService(
        prisma as never,
        access as never,
        projectRoles() as never,
      );

      const result =
        operation === 'update'
          ? service.update(user.id, project.id, { version: project.version, name: 'forbidden' })
          : service.archive(user.id, project.id, project.version);
      await expect(result).rejects.toBeInstanceOf(ForbiddenException);

      const stored = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
      expect(stored.name).toBe(`project-${operation}`);
      expect(stored.status).toBe('ACTIVE');
      expect(stored.deletedAt).toBeNull();
    },
  );

  it('does not leak project members after the caller membership is revoked by the precheck boundary', async () => {
    const { user, project, membership } = await createProjectManager('member-list');
    const colleague = await createUser('member-list-colleague');
    await prisma.projectMembership.create({
      data: {
        userId: colleague.id,
        projectId: project.id,
        roles: { create: [{ role: 'MEMBER' }] },
      },
    });
    const access = projectAccess(() => revokeProjectMembership(membership.id));
    const service = new ProjectsService(prisma as never, access as never, projectRoles() as never);

    await expect(service.listMembers(user.id, project.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it.each(['add', 'replace', 'remove'] as const)(
    'rejects project member %s after the acting manager permission is revoked by the precheck boundary',
    async (operation) => {
      const { user, project } = await createProjectManager(`member-${operation}`);
      const target = await createUser(`member-${operation}-target`);
      const targetMembership = await prisma.projectMembership.create({
        data: {
          userId: target.id,
          projectId: project.id,
          roles: { create: [{ role: 'MEMBER' }] },
        },
        select: { id: true },
      });
      const added = operation === 'add' ? await createUser('member-add-new') : null;
      const access = projectAccess(() => revokeSystemPermission(user.id));
      const service = new ProjectsService(
        prisma as never,
        access as never,
        projectRoles() as never,
      );

      const result =
        operation === 'add'
          ? service.addMember(user.id, project.id, added!.id, ['MEMBER'])
          : operation === 'replace'
            ? service.replaceMemberRoles(user.id, project.id, target.id, ['OBSERVER'])
            : service.removeMember(user.id, project.id, target.id);
      await expect(result).rejects.toBeInstanceOf(ForbiddenException);

      if (operation === 'add') {
        await expect(
          prisma.projectMembership.findUnique({
            where: { userId_projectId: { userId: added!.id, projectId: project.id } },
          }),
        ).resolves.toBeNull();
      } else {
        const retained = await prisma.projectMembership.findUniqueOrThrow({
          where: { id: targetMembership.id },
          include: { roles: true },
        });
        expect(retained.roles.map((entry) => entry.role)).toEqual(['MEMBER']);
      }
    },
  );

  it.each(['create', 'update', 'archive'] as const)(
    'rejects an order %s after project membership is revoked by the precheck boundary',
    async (operation) => {
      const { user, project, membership } = await createProjectManager(`order-${operation}`);
      const existing =
        operation === 'create'
          ? null
          : await prisma.order.create({
              data: {
                number: `O-${operation}`,
                title: `order-${operation}`,
                projectId: project.id,
              },
            });
      const access = projectAccess(() => revokeProjectMembership(membership.id));
      const service = new OrdersService(prisma as never, access as never, projectRoles() as never);

      const result =
        operation === 'create'
          ? service.create(user.id, project.id, { number: 'O-create', title: 'forbidden' })
          : operation === 'update'
            ? service.update(user.id, project.id, existing!.id, {
                version: existing!.version,
                title: 'forbidden',
              })
            : service.archive(user.id, project.id, existing!.id, existing!.version);
      await expect(result).rejects.toBeInstanceOf(NotFoundException);

      if (operation === 'create') {
        await expect(prisma.order.count({ where: { projectId: project.id } })).resolves.toBe(0);
      } else {
        const stored = await prisma.order.findUniqueOrThrow({ where: { id: existing!.id } });
        expect(stored.title).toBe(`order-${operation}`);
        expect(stored.status).toBe('DRAFT');
        expect(stored.deletedAt).toBeNull();
      }
    },
  );

  it('rolls back customer creation after project permission is revoked by the precheck boundary', async () => {
    const { user, project } = await createProjectManager('customer-create');
    const access = projectAccess(() => revokeSystemPermission(user.id));
    const service = new CustomersService(prisma as never, access as never, projectRoles() as never);

    await expect(
      service.create(user.id, {
        projectId: project.id,
        number: 'C-forbidden',
        name: 'forbidden',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    await expect(prisma.customer.count({ where: { number: 'C-forbidden' } })).resolves.toBe(0);
    await expect(
      prisma.project.findUniqueOrThrow({ where: { id: project.id }, select: { customerId: true } }),
    ).resolves.toEqual({ customerId: null });
  });

  it.each(['update', 'archive'] as const)(
    'classifies a visible customer %s as forbidden when the manager role is revoked at the final write',
    async (operation) => {
      const { user, project, membership } = await createProjectManager(
        `customer-final-${operation}`,
      );
      const customer = await prisma.customer.create({
        data: { number: `C-final-${operation}`, name: `customer-${operation}` },
      });
      await prisma.project.update({
        where: { id: project.id },
        data: { customerId: customer.id },
      });
      const originalUpdateMany = prisma.customer.updateMany.bind(prisma.customer);
      let revoked = false;
      const hookedPrisma = {
        ...prisma,
        customer: {
          ...prisma.customer,
          findFirst: prisma.customer.findFirst.bind(prisma.customer),
          updateMany: async (...args: Parameters<typeof originalUpdateMany>) => {
            if (!revoked) {
              revoked = true;
              await prisma.projectMembershipRole.deleteMany({
                where: { membershipId: membership.id },
              });
            }
            return originalUpdateMany(...args);
          },
        },
      };
      const access = {
        resolveProjectScope: vi.fn().mockResolvedValue([project.id]),
        listProjectRoles: vi.fn().mockResolvedValue(['PROJECT_MANAGER']),
      };
      const service = new CustomersService(
        hookedPrisma as never,
        access as never,
        projectRoles() as never,
      );

      const result =
        operation === 'update'
          ? service.update(user.id, customer.id, {
              version: customer.version,
              name: 'must not persist',
            })
          : service.archive(user.id, customer.id, customer.version);
      await expect(result).rejects.toBeInstanceOf(ForbiddenException);

      await expect(
        prisma.customer.findUniqueOrThrow({ where: { id: customer.id } }),
      ).resolves.toMatchObject({
        name: `customer-${operation}`,
        status: 'ACTIVE',
        deletedAt: null,
        version: customer.version,
      });
    },
  );

  it.each(['create', 'update', 'archive'] as const)(
    'classifies a visible customer contact %s as forbidden when the manager role is revoked before the transaction',
    async (operation) => {
      const { user, project, membership } = await createProjectManager(
        `contact-final-${operation}`,
      );
      const customer = await prisma.customer.create({
        data: { number: `C-contact-${operation}`, name: `contact-parent-${operation}` },
      });
      await prisma.project.update({
        where: { id: project.id },
        data: { customerId: customer.id },
      });
      const contact = await prisma.customerContact.create({
        data: { customerId: customer.id, name: `contact-${operation}` },
      });
      const hookedPrisma = {
        ...prisma,
        customer: prisma.customer,
        $transaction: async <T>(
          work: Parameters<typeof prisma.$transaction>[0],
          options?: Parameters<typeof prisma.$transaction>[1],
        ): Promise<T> => {
          await prisma.projectMembershipRole.deleteMany({ where: { membershipId: membership.id } });
          return prisma.$transaction(work, options) as Promise<T>;
        },
      };
      const access = {
        resolveProjectScope: vi.fn().mockResolvedValue([project.id]),
        listProjectRoles: vi.fn().mockResolvedValue(['PROJECT_MANAGER']),
      };
      const service = new CustomersService(
        hookedPrisma as never,
        access as never,
        projectRoles() as never,
      );

      const result =
        operation === 'create'
          ? service.createContact(user.id, customer.id, {
              version: customer.version,
              name: 'must not persist',
            })
          : operation === 'update'
            ? service.updateContact(user.id, customer.id, contact.id, {
                version: customer.version,
                name: 'must not persist',
              })
            : service.archiveContact(user.id, customer.id, contact.id, customer.version);
      await expect(result).rejects.toBeInstanceOf(ForbiddenException);

      await expect(
        prisma.customer.findUniqueOrThrow({ where: { id: customer.id } }),
      ).resolves.toMatchObject({ version: customer.version });
      await expect(
        prisma.customerContact.findUniqueOrThrow({ where: { id: contact.id } }),
      ).resolves.toMatchObject({ name: `contact-${operation}`, archivedAt: null });
      await expect(
        prisma.customerContact.count({ where: { customerId: customer.id } }),
      ).resolves.toBe(1);
    },
  );

  it('rolls back portfolio creation when portfolio:manage is revoked after the precheck', async () => {
    const user = await createUser('portfolio-create');
    await grantPermission(user.id, 'portfolio:manage');
    const roles = {
      listUserPermissions: vi.fn(async () => {
        await revokeSystemPermission(user.id);
        return ['portfolio:manage'];
      }),
    };
    const service = new PortfoliosService(prisma as never, roles as never);

    await expect(service.create(user.id, { name: 'forbidden-portfolio' })).rejects.toBeInstanceOf(
      ForbiddenException,
    );

    await expect(prisma.portfolio.count({ where: { name: 'forbidden-portfolio' } })).resolves.toBe(
      0,
    );
    await expect(prisma.portfolioMembership.count({ where: { userId: user.id } })).resolves.toBe(0);
  });

  it.each(['update', 'archive'] as const)(
    'rejects a portfolio %s after portfolio:manage is revoked by the precheck boundary',
    async (operation) => {
      const user = await createUser(`portfolio-${operation}`);
      await grantPermission(user.id, 'portfolio:manage');
      const portfolio = await prisma.portfolio.create({
        data: {
          name: `portfolio-${operation}`,
          memberships: { create: [{ userId: user.id }] },
        },
      });
      const roles = {
        listUserPermissions: vi.fn(async () => {
          await revokeSystemPermission(user.id);
          return ['portfolio:manage'];
        }),
      };
      const service = new PortfoliosService(prisma as never, roles as never);

      const result =
        operation === 'update'
          ? service.update(user.id, portfolio.id, { name: 'forbidden' })
          : service.archive(user.id, portfolio.id);
      await expect(result).rejects.toBeInstanceOf(ForbiddenException);

      const stored = await prisma.portfolio.findUniqueOrThrow({ where: { id: portfolio.id } });
      expect(stored.name).toBe(`portfolio-${operation}`);
      expect(stored.status).toBe('ACTIVE');
      expect(stored.deletedAt).toBeNull();
    },
  );
});
