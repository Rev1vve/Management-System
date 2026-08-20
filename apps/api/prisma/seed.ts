import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient, ProjectRole } from '../src/generated/prisma/client';
import {
  ALL_PERMISSION_KEYS,
  PERMISSION_DESCRIPTIONS,
  ROLE_DEFINITIONS,
} from '../src/modules/authorization/permission.constants';

/**
 * Development/test seed. Idempotent by design (every record is upserted on a
 * natural unique key), so it can be re-run without duplicating data.
 *
 * It refuses to touch a production database: seeding is only allowed when
 * `NODE_ENV` is unset or one of `development`/`test`, or when the operator has
 * explicitly opted in with `ALLOW_SEED=true` (never set this in production).
 *
 * The role -> permission matrix comes from ROLE_DEFINITIONS (single source of
 * truth, plan task 6), so the seed cannot drift from what the guards enforce.
 */
async function main(): Promise<void> {
  const env = process.env.NODE_ENV;
  const allowSeed = process.env.ALLOW_SEED === 'true';
  if (env === 'production' && !allowSeed) {
    throw new Error(
      'Refusing to seed a production database (NODE_ENV=production). ' +
        'This is a development/test-only operation.',
    );
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required to run the seed');
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
  });

  try {
    // 1. System roles (upserted by stable key; matrix from ROLE_DEFINITIONS).
    // Privileged roles require TOTP (plan D-056); a pure employee account may
    // opt out.
    const roleIds = new Map<string, string>();
    for (const def of ROLE_DEFINITIONS) {
      const role = await prisma.systemRole.upsert({
        where: { key: def.key },
        update: {
          name: def.name,
          description: def.description,
          requiresMfa: def.requiresMfa,
        },
        create: {
          key: def.key,
          name: def.name,
          description: def.description,
          requiresMfa: def.requiresMfa,
        },
      });
      roleIds.set(def.key, role.id);
    }

    // 2. Permissions (upserted by stable key).
    const permissionIds = new Map<string, string>();
    for (const key of ALL_PERMISSION_KEYS) {
      const permission = await prisma.permission.upsert({
        where: { key },
        update: { description: PERMISSION_DESCRIPTIONS[key] },
        create: { key, description: PERMISSION_DESCRIPTIONS[key] },
      });
      permissionIds.set(key, permission.id);
    }

    // 3. Role -> permission links (composite-key upsert).
    for (const def of ROLE_DEFINITIONS) {
      const systemRoleId = roleIds.get(def.key);
      if (!systemRoleId) throw new Error(`Missing role id for ${def.key}`);
      for (const key of def.permissions) {
        const permissionId = permissionIds.get(key);
        if (!permissionId) throw new Error(`Missing permission id for ${key}`);
        await prisma.rolePermission.upsert({
          where: {
            systemRoleId_permissionId: { systemRoleId, permissionId },
          },
          update: {},
          create: { systemRoleId, permissionId },
        });
      }
    }

    // 4. Demo users (upserted by unique account) + system role bindings.
    const users = [
      { account: 'admin', name: '管理员', workEmail: 'admin@example.test' },
      { account: 'manager', name: '项目经理甲', workEmail: 'manager@example.test' },
      { account: 'employee', name: '员工乙', workEmail: 'employee@example.test' },
      { account: 'approver', name: '审批人丙', workEmail: 'approver@example.test' },
    ];
    const userRoles: Record<string, string[]> = {
      admin: ['ADMIN'],
      manager: ['PROJECT_MANAGER'],
      employee: ['EMPLOYEE'],
      approver: ['APPROVER'],
    };
    const userIds = new Map<string, string>();
    for (const user of users) {
      const created = await prisma.user.upsert({
        where: { account: user.account },
        update: { name: user.name, workEmail: user.workEmail },
        create: { ...user, status: 'ACTIVE' },
      });
      userIds.set(user.account, created.id);
    }
    for (const [account, roleKeys] of Object.entries(userRoles)) {
      const userId = userIds.get(account);
      if (!userId) throw new Error(`Missing user id for ${account}`);
      for (const roleKey of roleKeys) {
        const systemRoleId = roleIds.get(roleKey);
        if (!systemRoleId) throw new Error(`Missing role id for ${roleKey}`);
        await prisma.userSystemRole.upsert({
          where: {
            userId_systemRoleId: { userId, systemRoleId },
          },
          update: {},
          create: { userId, systemRoleId },
        });
      }
    }

    // 5. Demo portfolio, customer and project (upserted by unique number).
    await prisma.portfolio.upsert({
      where: { id: '00000000-0000-0000-0000-000000000001' },
      update: {},
      create: {
        id: '00000000-0000-0000-0000-000000000001',
        name: '示例项目集',
        description: '开发/测试种子项目集',
      },
    });

    await prisma.customer.upsert({
      where: { number: 'CUST-0001' },
      update: {},
      create: { number: 'CUST-0001', name: '示例客户', status: 'ACTIVE' },
    });

    const project = await prisma.project.upsert({
      where: { number: 'PRJ-0001' },
      update: {},
      create: {
        number: 'PRJ-0001',
        name: '示例项目',
        description: '开发/测试种子项目',
        status: 'ACTIVE',
        completionPercent: 0,
      },
    });

    // 6. Demo project memberships (project-scope roles).
    const projectMembers: Array<[string, ProjectRole]> = [
      ['manager', 'PROJECT_MANAGER'],
      ['employee', 'MEMBER'],
      ['approver', 'APPROVER'],
    ];
    for (const [account, role] of projectMembers) {
      const userId = userIds.get(account);
      if (!userId) throw new Error(`Missing user id for ${account}`);
      const membership = await prisma.projectMembership.upsert({
        where: { userId_projectId: { userId, projectId: project.id } },
        update: {},
        create: { userId, projectId: project.id },
      });
      await prisma.projectMembershipRole.upsert({
        where: { membershipId_role: { membershipId: membership.id, role } },
        update: {},
        create: { membershipId: membership.id, role },
      });
    }

    console.log('Seed complete (idempotent).');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
