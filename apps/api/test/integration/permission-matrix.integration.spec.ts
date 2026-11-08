import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../../src/app.module';
import { randomToken, sha256Hex } from '../../src/crypto/token.util';
import { PrismaService } from '../../src/database/prisma.service';
import {
  ALL_PERMISSION_KEYS,
  ROLE_DEFINITIONS,
} from '../../src/modules/authorization/permission.constants';
import { installWindowsAclAllowlist } from '../../src/testing/windows-acl-allowlist';
import { configureApp } from '../../src/startup-config';

/**
 * 任务 12：权限矩阵（真实 HTTP + 真实 PostgreSQL）。
 *
 * 目的不是再测一遍业务，而是把"谁能访问什么"钉成一张表：
 * 每个系统角色 × 每个受保护端点的期望状态码。任何一次权限改动若打破矩阵，
 * 这里会直接红——而不是等到某个人在浏览器里点了才发现。
 */
const TABLES = [
  'mfa_recovery_codes',
  'invitations',
  'notifications',
  'email_outbox',
  'project_events',
  'approval_decisions',
  'approval_requests',
  'attachments',
  'work_log_versions',
  'work_logs',
  'system_settings',
  'audit_logs',
  'attachments',
  'order_items',
  'orders',
  'customer_contacts',
  'project_membership_roles',
  'project_memberships',
  'portfolio_memberships',
  'projects',
  'portfolios',
  'customers',
  'sessions',
  'user_system_roles',
  'role_permissions',
  'permissions',
  'system_roles',
  'users',
];

let app: INestApplication;
let prisma: PrismaService;
let attachmentRoot: string;

type RoleKey =
  'EMPLOYEE' | 'APPROVER' | 'PROJECT_MANAGER' | 'PORTFOLIO_DIRECTOR' | 'EXECUTIVE' | 'ADMIN';

const ROLE_KEYS: RoleKey[] = [
  'EMPLOYEE',
  'APPROVER',
  'PROJECT_MANAGER',
  'PORTFOLIO_DIRECTOR',
  'EXECUTIVE',
  'ADMIN',
];

async function truncateAll(): Promise<void> {
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${TABLES.map((table) => `"${table}"`).join(', ')} RESTART IDENTITY CASCADE`,
  );
}

async function seedRoles(): Promise<void> {
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
    for (const permissionKey of definition.permissions) {
      const permission = await prisma.permission.findUniqueOrThrow({
        where: { key: permissionKey },
      });
      await prisma.rolePermission.upsert({
        where: {
          systemRoleId_permissionId: {
            systemRoleId: role.id,
            permissionId: permission.id,
          },
        },
        update: {},
        create: { systemRoleId: role.id, permissionId: permission.id },
      });
    }
  }
}

async function createUserWithRole(role: RoleKey): Promise<string> {
  const user = await prisma.user.create({
    data: {
      account: `${role.toLowerCase()}-matrix`,
      name: role,
      // 前缀避免与 seed 的演示邮箱冲突（work_email 唯一，撞了会让 seed 失败）。
      workEmail: `matrix-${role.toLowerCase()}@example.test`,
      status: 'ACTIVE',
      mfaEnabled: true,
    },
  });
  const systemRole = await prisma.systemRole.findUniqueOrThrow({ where: { key: role } });
  await prisma.userSystemRole.create({ data: { userId: user.id, systemRoleId: systemRole.id } });
  return user.id;
}

async function cookieFor(userId: string): Promise<string> {
  const token = randomToken(32);
  await prisma.session.create({
    data: {
      userId,
      tokenHash: sha256Hex(token),
      status: 'ACTIVE',
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  });
  return `poc_session=${token}`;
}

beforeAll(async () => {
  await installWindowsAclAllowlist();
  attachmentRoot = await mkdtemp(join(tmpdir(), 'poc-matrix-'));
  process.env.ATTACHMENTS_ROOT = attachmentRoot;
  process.env.MFA_SECRET_KEY = '33'.repeat(32);
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();
  prisma = moduleRef.get(PrismaService);
});

beforeEach(async () => {
  await truncateAll();
  await seedRoles();
});

afterAll(async () => {
  await app.close();
  await rm(attachmentRoot, { recursive: true, force: true });
});

/**
 * 期望矩阵：200 = 允许；403 = 有登录但缺权限。
 * 报表端点的作用域收窄体现在数据上（空集），因此它们对多数角色是 200。
 */
const MATRIX: Array<{ path: string; allowed: RoleKey[] }> = [
  { path: '/api/v1/admin/users', allowed: ['ADMIN'] },
  { path: '/api/v1/admin/roles', allowed: ['ADMIN'] },
  { path: '/api/v1/admin/audit', allowed: ['ADMIN'] },
  { path: '/api/v1/reports/summary', allowed: ROLE_KEYS },
  { path: '/api/v1/reports/projects', allowed: ROLE_KEYS },
  { path: '/api/v1/reports/managed-projects', allowed: ROLE_KEYS },
  { path: '/api/v1/reports/portfolios', allowed: ROLE_KEYS },
  { path: '/api/v1/my/work-logs', allowed: ROLE_KEYS },
  { path: '/api/v1/approvals', allowed: ROLE_KEYS },
  { path: '/api/v1/notifications', allowed: ROLE_KEYS },
];

describe('permission matrix (real HTTP)', () => {
  it.each(MATRIX)('enforces the role matrix for $path', async ({ path, allowed }) => {
    const cookies = new Map<RoleKey, string>();
    for (const role of ROLE_KEYS) {
      cookies.set(role, await cookieFor(await createUserWithRole(role)));
    }

    for (const role of ROLE_KEYS) {
      const response = await request(app.getHttpServer())
        .get(path)
        .set('Cookie', [cookies.get(role)!]);
      const expected = allowed.includes(role) ? 200 : 403;
      expect({ role, path, status: response.status }).toEqual({
        role,
        path,
        status: expected,
      });
    }
  });

  it('never lets an administrator read business data through admin rights', async () => {
    const adminId = await createUserWithRole('ADMIN');
    const cookie = await cookieFor(adminId);
    const project = await prisma.project.create({
      data: { number: 'PRJ-ADMIN', name: '管理员不该看见的项目', status: 'ACTIVE' },
    });
    await prisma.workLog.create({
      data: {
        number: 'WL-ADMIN-1',
        authorId: adminId,
        projectId: project.id,
        status: 'DRAFT',
        visibility: 'PRIVATE',
        version: 1,
      },
    });

    // 报表对 ADMIN 是 200，但作用域是"只看自己"，不应出现别人的项目聚合。
    const summary = await request(app.getHttpServer())
      .get('/api/v1/reports/summary')
      .set('Cookie', [cookie]);
    expect(summary.status).toBe(200);
    expect(summary.body.scope).toBe('OWN');

    const projects = await request(app.getHttpServer())
      .get('/api/v1/projects')
      .set('Cookie', [cookie]);
    expect(projects.status).toBe(200);
    expect(projects.body.items).toEqual([]);
  });
});

describe('denial paths (real HTTP)', () => {
  // 每个端点都要单独证明"匿名不可读"：整表对全角色放行的端点如果漏了守卫，
  // 只测一个 /admin/users 是发现不了的。
  it.each(MATRIX)('rejects an anonymous request to $path', async ({ path }) => {
    const response = await request(app.getHttpServer()).get(path);
    expect({ path, status: response.status }).toEqual({ path, status: 401 });
  });

  it('rejects a suspended account holding a valid session', async () => {
    const userId = await createUserWithRole('ADMIN');
    const cookie = await cookieFor(userId);
    await prisma.user.update({ where: { id: userId }, data: { status: 'SUSPENDED' } });

    const response = await request(app.getHttpServer())
      .get('/api/v1/admin/users')
      .set('Cookie', [cookie]);
    expect(response.status).toBe(401);
  });

  it('rejects a revoked session', async () => {
    const userId = await createUserWithRole('ADMIN');
    const cookie = await cookieFor(userId);
    await prisma.session.updateMany({ where: { userId }, data: { revokedAt: new Date() } });

    const response = await request(app.getHttpServer())
      .get('/api/v1/admin/users')
      .set('Cookie', [cookie]);
    expect(response.status).toBe(401);
  });

  it('rejects a state-changing request without the CSRF header', async () => {
    const userId = await createUserWithRole('ADMIN');
    const cookie = await cookieFor(userId);

    const response = await request(app.getHttpServer())
      .patch('/api/v1/admin/users/whatever/status')
      .set('Cookie', [cookie])
      .send({ status: 'SUSPENDED' });
    expect(response.status).toBe(401);
  });

  it('refuses to let an administrator lock themselves out', async () => {
    const userId = await createUserWithRole('ADMIN');
    const cookie = await cookieFor(userId);

    const response = await request(app.getHttpServer())
      .patch(`/api/v1/admin/users/${userId}/status`)
      .set('Cookie', [cookie])
      .set('x-requested-with', 'XMLHttpRequest')
      .send({ status: 'SUSPENDED' });
    expect(response.status).toBe(403);
  });

  it('refuses an unknown system role and an unknown status', async () => {
    const adminId = await createUserWithRole('ADMIN');
    const targetId = await createUserWithRole('EMPLOYEE');
    const cookie = await cookieFor(adminId);

    const badRole = await request(app.getHttpServer())
      .put(`/api/v1/admin/users/${targetId}/roles`)
      .set('Cookie', [cookie])
      .set('x-requested-with', 'XMLHttpRequest')
      .send({ roles: ['NOT_A_ROLE'] });
    expect(badRole.status).toBe(400);

    const badStatus = await request(app.getHttpServer())
      .patch(`/api/v1/admin/users/${targetId}/status`)
      .set('Cookie', [cookie])
      .set('x-requested-with', 'XMLHttpRequest')
      .send({ status: 'DELETED' });
    expect(badStatus.status).toBe(400);
  });

  it('refuses a privileged role for a user without TOTP', async () => {
    const adminId = await createUserWithRole('ADMIN');
    const cookie = await cookieFor(adminId);
    const target = await prisma.user.create({
      data: {
        account: 'no-totp',
        name: 'no-totp',
        workEmail: 'no-totp@example.test',
        status: 'ACTIVE',
        mfaEnabled: false,
      },
    });

    const response = await request(app.getHttpServer())
      .put(`/api/v1/admin/users/${target.id}/roles`)
      .set('Cookie', [cookie])
      .set('x-requested-with', 'XMLHttpRequest')
      .send({ roles: ['EXECUTIVE'] });
    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/双因素/);
  });
});
