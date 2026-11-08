import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PrismaService } from '../../src/database/prisma.service';
import { AuditService } from '../../src/modules/audit/audit.service';
import { AdminAuditService } from '../../src/modules/admin/admin-audit.service';
import { AdminUsersService } from '../../src/modules/admin/admin-users.service';
import {
  ALL_PERMISSION_KEYS,
  PERMISSIONS,
  ROLE_DEFINITIONS,
} from '../../src/modules/authorization/permission.constants';
import { RolesService } from '../../src/modules/roles/roles.service';

/**
 * 管理中心（任务 11，真实 PostgreSQL）：
 *  - 用户列表不带凭据字段；
 *  - 角色授予能真的把 `report:drilldown` 给到某个用户；
 *  - 所有写操作留下审计，且审计只能追加（没有写接口）。
 */
const prisma = new PrismaService();

const TABLES = ['audit_logs', 'user_system_roles', 'sessions', 'users'];

async function truncateAll(): Promise<void> {
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`,
  );
}

let users: AdminUsersService;
let audits: AdminAuditService;

async function ensureSystemRoles(): Promise<void> {
  // 权限行本身也要补齐：同一库上其它 spec 会清空 permissions，
  // 而 report:drilldown 不属于任何默认角色，只能在这里显式创建。
  for (const key of ALL_PERMISSION_KEYS) {
    await prisma.permission.upsert({
      where: { key },
      update: {},
      create: { key, description: key },
    });
  }
  for (const definition of ROLE_DEFINITIONS) {
    const role = await prisma.systemRole.upsert({
      where: { key: definition.key },
      update: { name: definition.name, requiresMfa: definition.requiresMfa },
      create: { key: definition.key, name: definition.name, requiresMfa: definition.requiresMfa },
    });
    for (const key of definition.permissions) {
      const permission = await prisma.permission.upsert({
        where: { key },
        update: {},
        create: { key, description: key },
      });
      await prisma.rolePermission.upsert({
        where: {
          systemRoleId_permissionId: { systemRoleId: role.id, permissionId: permission.id },
        },
        update: {},
        create: { systemRoleId: role.id, permissionId: permission.id },
      });
    }
  }
}

beforeAll(() => {
  const audit = new AuditService(prisma);
  users = new AdminUsersService(prisma, audit);
  audits = new AdminAuditService(prisma);
});

beforeEach(async () => {
  await truncateAll();
  // 用例会临时创建角色（例如授予 report:drilldown 的临时角色），每个用例后清掉，
  // 否则"默认角色都不含下钻"这种断言会被上一个用例的残留推翻。
  const tempRoles = await prisma.systemRole.findMany({
    where: { key: { notIn: ROLE_DEFINITIONS.map((definition) => definition.key) } },
    select: { id: true },
  });
  for (const role of tempRoles) {
    await prisma.rolePermission.deleteMany({ where: { systemRoleId: role.id } });
    await prisma.userSystemRole.deleteMany({ where: { systemRoleId: role.id } });
    await prisma.systemRole.delete({ where: { id: role.id } });
  }
  await ensureSystemRoles();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function createUser(account: string): Promise<string> {
  const user = await prisma.user.create({
    data: { account, name: account, workEmail: `${account}@example.test`, status: 'ACTIVE' },
  });
  return user.id;
}

async function grantRole(userId: string, roleKey: string): Promise<void> {
  const role = await prisma.systemRole.findUniqueOrThrow({ where: { key: roleKey } });
  await prisma.userSystemRole.create({ data: { userId, systemRoleId: role.id } });
}

describe('admin users (real PostgreSQL)', () => {
  it('lists users without credential fields and with their roles', async () => {
    const userId = await createUser('alice');
    await grantRole(userId, 'EMPLOYEE');

    const page = await users.listUsers({ page: 1, pageSize: 10 });

    expect(page.total).toBe(1);
    const row = page.items[0]!;
    expect(row).toMatchObject({ account: 'alice', status: 'ACTIVE' });
    expect(row.roles).toEqual([expect.objectContaining({ key: 'EMPLOYEE' })]);
    // 凭据类字段一个都不能出现在响应里。
    expect(Object.keys(row)).not.toContain('passwordHash');
    expect(Object.keys(row)).not.toContain('mfaSecretCiphertext');
  });

  it('grants report:drilldown through a role and records the audit trail', async () => {
    const adminId = await createUser('admin');
    const executiveId = await createUser('exec');
    await grantRole(executiveId, 'EXECUTIVE');

    // 管理中心只能整体替换系统角色；报表下钻通过"临时角色"授予。
    const drilldown = await prisma.permission.findUniqueOrThrow({
      where: { key: PERMISSIONS.REPORT_DRILLDOWN },
    });
    const tempRole = await prisma.systemRole.create({
      data: { key: 'REPORT_DRILLDOWN_TEMP', name: '报表下钻（临时）' },
    });
    await prisma.rolePermission.create({
      data: { systemRoleId: tempRole.id, permissionId: drilldown.id },
    });

    await users.setRoles(adminId, executiveId, ['EXECUTIVE', 'REPORT_DRILLDOWN_TEMP']);

    const permissions = await new RolesService(prisma).listUserPermissions(executiveId);
    expect(permissions).toContain(PERMISSIONS.REPORT_DRILLDOWN);

    const log = await audits.list({ page: 1, pageSize: 10, action: 'user.roles.changed' });
    expect(log.total).toBe(1);
    expect(log.items[0]!.actorId).toBe(adminId);
    expect(log.items[0]!.resourceId).toBe(executiveId);
  });

  it('suspends a user and refuses to touch your own account', async () => {
    const adminId = await createUser('admin');
    const targetId = await createUser('bob');

    await users.setStatus(adminId, targetId, 'SUSPENDED');
    const suspended = await prisma.user.findUniqueOrThrow({ where: { id: targetId } });
    expect(suspended.status).toBe('SUSPENDED');

    await expect(users.setStatus(adminId, adminId, 'SUSPENDED')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(users.setRoles(adminId, adminId, ['ADMIN'])).rejects.toBeInstanceOf(
      ForbiddenException,
    );

    const audit = await audits.list({ page: 1, pageSize: 10 });
    expect(audit.items.map((row) => row.action)).toContain('user.status.changed');
  });

  it('refuses an unknown user or role', async () => {
    const adminId = await createUser('admin');

    await expect(users.setStatus(adminId, 'ghost', 'SUSPENDED')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(users.setRoles(adminId, 'ghost', ['ADMIN'])).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(users.setRoles(adminId, adminId, ['NOPE'])).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('exposes the role catalogue with permissions', async () => {
    const roles = await users.listRoles();
    const executive = roles.find((role) => role.key === 'EXECUTIVE');

    expect(executive?.permissions).toContain(PERMISSIONS.REPORT_VIEW_ALL);
    // report:drilldown 不属于任何默认角色（D-027）。
    expect(roles.some((role) => role.permissions.includes(PERMISSIONS.REPORT_DRILLDOWN))).toBe(
      false,
    );
  });
});

describe('admin audit (real PostgreSQL)', () => {
  it('filters by actor and business-day range and stays read-only', async () => {
    const adminId = await createUser('admin');
    const targetId = await createUser('bob');
    await users.setStatus(adminId, targetId, 'SUSPENDED');

    const page = await audits.list({ page: 1, pageSize: 10, actorId: adminId });
    expect(page.total).toBe(1);
    expect(page.items[0]!.actor?.id).toBe(adminId);
    expect(page.timezone).toBe('Australia/Melbourne');

    // 审计只能追加：服务层不暴露任何写接口。
    expect(
      Object.getOwnPropertyNames(AdminAuditService.prototype).filter((name) =>
        /create|update|delete|write/i.test(name),
      ),
    ).toEqual([]);
  });
});
