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
 * 任务 12：业务日边界的端到端验证（真实 HTTP + 真实 PostgreSQL）。
 *
 * D-051 要求报表按 Australia/Melbourne 切分自然日，而数据库存 UTC。
 * 这里用真实夏令时切换日证明切分规则：
 *  - 2026-10-04（春季转换，本地日 23 小时）
 *  - 2027-04-04（秋季转换，本地日 25 小时）
 * 关键断言：同样是 13:30Z，在 11 月已经属于"次日"，在 4 月仍属于"当天"。
 */
const TABLES = [
  'approval_decisions',
  'approval_requests',
  'notifications',
  'email_outbox',
  'project_events',
  'attachments',
  'work_log_versions',
  'work_logs',
  'project_membership_roles',
  'project_memberships',
  'projects',
  'users',
  'sessions',
  'user_system_roles',
];

let app: INestApplication;
let prisma: PrismaService;
let attachmentRoot: string;

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
          systemRoleId_permissionId: { systemRoleId: role.id, permissionId: permission.id },
        },
        update: {},
        create: { systemRoleId: role.id, permissionId: permission.id },
      });
    }
  }
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
  attachmentRoot = await mkdtemp(join(tmpdir(), 'poc-dst-'));
  process.env.ATTACHMENTS_ROOT = attachmentRoot;
  process.env.MFA_SECRET_KEY = '44'.repeat(32);
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

async function createEmployeeWithLog(
  workDate: string,
  hours: number,
): Promise<{ userId: string; cookie: string }> {
  const user = await prisma.user.create({
    data: {
      account: `dst-${workDate}-${hours}`,
      name: 'DST',
      workEmail: `dst-${workDate}-${hours}@example.test`,
      status: 'ACTIVE',
    },
  });
  const role = await prisma.systemRole.findUniqueOrThrow({ where: { key: 'EMPLOYEE' } });
  await prisma.userSystemRole.create({ data: { userId: user.id, systemRoleId: role.id } });
  const project = await prisma.project.create({
    data: { number: `PRJ-${workDate}-${hours}`, name: 'DST 项目', status: 'ACTIVE' },
  });
  await prisma.projectMembership.create({
    data: { userId: user.id, projectId: project.id, roles: { create: [{ role: 'MEMBER' }] } },
  });
  // 数据库守卫要求"新建日志必须是 DRAFT"；先建草稿、挂上版本，再单独提交。
  const log = await prisma.workLog.create({
    data: {
      number: `WL-${workDate}-${hours}`,
      authorId: user.id,
      projectId: project.id,
      status: 'DRAFT',
      visibility: 'PRIVATE',
      version: 1,
    },
  });
  const version = await prisma.workLogVersion.create({
    data: {
      workLogId: log.id,
      versionNumber: 1,
      workDate: new Date(`${workDate}T00:00:00.000Z`),
      hours: String(hours),
      completion: 'DST 边界',
      submittedById: user.id,
      submittedAt: new Date(),
    },
  });
  await prisma.workLog.update({
    where: { id: log.id },
    data: { currentVersionId: version.id },
  });
  await prisma.workLog.update({
    where: { id: log.id },
    data: { status: 'SUBMITTED' },
  });
  return { userId: user.id, cookie: await cookieFor(user.id) };
}

async function summary(cookie: string, from: string, to: string) {
  const response = await request(app.getHttpServer())
    .get(`/api/v1/reports/summary?from=${from}&to=${to}`)
    .set('Cookie', [cookie]);
  expect(response.status).toBe(200);
  return response.body as {
    hours: { total: number };
    range: { from: string; to: string; timezone: string };
  };
}

describe('business-day boundaries across DST (real HTTP)', () => {
  it('includes a 23-hour day exactly once when the local day is the DST spring-forward', async () => {
    const { cookie } = await createEmployeeWithLog('2026-10-04', 3);

    const day = await summary(cookie, '2026-10-04', '2026-10-04');
    expect(day.hours.total).toBe(3);
    expect(day.range.timezone).toBe('Australia/Melbourne');

    // 前后各一天都不能把它算进去。
    const before = await summary(cookie, '2026-10-03', '2026-10-03');
    const after = await summary(cookie, '2026-10-05', '2026-10-05');
    expect(before.hours.total).toBe(0);
    expect(after.hours.total).toBe(0);
  });

  it('keeps a 25-hour day whole when the local day is the DST fall-back', async () => {
    const { cookie } = await createEmployeeWithLog('2027-04-04', 5);

    const day = await summary(cookie, '2027-04-04', '2027-04-04');
    expect(day.hours.total).toBe(5);
  });

  it('splits decisions by local midnight, not by 13:30Z being "next day" all year', async () => {
    const { userId, cookie } = await createEmployeeWithLog('2026-10-04', 1);
    const approver = await prisma.user.create({
      data: {
        account: 'dst-approver',
        name: '审批人',
        workEmail: 'dst-approver@example.test',
        status: 'ACTIVE',
      },
    });
    const log = await prisma.workLog.findFirstOrThrow({ where: { authorId: userId } });
    const approval = await prisma.approvalRequest.create({
      data: {
        workLogVersionId: log.currentVersionId!,
        approverId: approver.id,
        submitterId: userId,
        status: 'APPROVED',
        processedAt: new Date('2026-10-04T13:30:00.000Z'),
      },
    });
    await prisma.approvalDecision.create({
      data: {
        approvalRequestId: approval.id,
        decision: 'APPROVED',
        decidedById: approver.id,
        // 11 月时 13:30Z 已是次日 00:30（AEDT +11）；10 月 4 日刚切换，同样时间仍是当天 00:30？见下一条断言。
        decidedAt: new Date('2026-10-04T13:30:00.000Z'),
      },
    });

    const sameDay = await summary(cookie, '2026-10-04', '2026-10-04');
    const nextDay = await summary(cookie, '2026-10-05', '2026-10-05');

    // 10-04 当天 AEDT=+11，13:30Z 已经是本地 10-05 00:30。
    expect(nextDay.hours.total + sameDay.hours.total).toBe(1);
    const nextDayDecided = await request(app.getHttpServer())
      .get('/api/v1/reports/summary?from=2026-10-05&to=2026-10-05')
      .set('Cookie', [cookie]);
    expect(nextDayDecided.body.approvals.decided.approved).toBe(1);

    const sameDayDecided = await request(app.getHttpServer())
      .get('/api/v1/reports/summary?from=2026-10-04&to=2026-10-04')
      .set('Cookie', [cookie]);
    expect(sameDayDecided.body.approvals.decided.approved).toBe(0);
  });

  it('treats 13:30Z as still the same local day once AEDT has ended', async () => {
    const { userId, cookie } = await createEmployeeWithLog('2027-04-04', 1);
    const approver = await prisma.user.create({
      data: {
        account: 'dst-approver-fall',
        name: '审批人',
        workEmail: 'dst-approver-fall@example.test',
        status: 'ACTIVE',
      },
    });
    const log = await prisma.workLog.findFirstOrThrow({ where: { authorId: userId } });
    const approval = await prisma.approvalRequest.create({
      data: {
        workLogVersionId: log.currentVersionId!,
        approverId: approver.id,
        submitterId: userId,
        status: 'APPROVED',
      },
    });
    await prisma.approvalDecision.create({
      data: {
        approvalRequestId: approval.id,
        decision: 'APPROVED',
        decidedById: approver.id,
        // AEST = UTC+10：13:30Z 是本地 23:30，仍属于 2027-04-04。
        decidedAt: new Date('2027-04-04T13:30:00.000Z'),
      },
    });

    const sameDay = await request(app.getHttpServer())
      .get('/api/v1/reports/summary?from=2027-04-04&to=2027-04-04')
      .set('Cookie', [cookie]);
    const nextDay = await request(app.getHttpServer())
      .get('/api/v1/reports/summary?from=2027-04-05&to=2027-04-05')
      .set('Cookie', [cookie]);

    // 与 11 月相反：同样的 13:30Z 在秋季转换后仍算当天。
    expect(sameDay.body.approvals.decided.approved).toBe(1);
    expect(nextDay.body.approvals.decided.approved).toBe(0);
  });
});
