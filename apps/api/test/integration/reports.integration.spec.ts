import { ForbiddenException } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PrismaService } from '../../src/database/prisma.service';
import {
  PERMISSIONS,
  ROLE_DEFINITIONS,
} from '../../src/modules/authorization/permission.constants';
import type { ProjectRole } from '../../src/generated/prisma/client';
import { ProjectAccessService } from '../../src/modules/project-access/project-access.service';
import { ReportsService } from '../../src/modules/reports/reports.service';
import { RolesService } from '../../src/modules/roles/roles.service';
import { WorkLogsService } from '../../src/modules/work-logs/work-logs.service';

/**
 * 任务 10 报表（真实 PostgreSQL）。
 *
 * 证明：汇总与源数据一致；员工只看自己；有跨项目能力的人看授权项目聚合；
 * 明细下钻必须额外持有 `report:drilldown`，否则即使高层也被拒（D-027）。
 */
const prisma = new PrismaService();

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
];

async function truncateAll(): Promise<void> {
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`,
  );
}

let reports: ReportsService;
let workLogs: WorkLogsService;

beforeAll(() => {
  reports = new ReportsService(prisma, new RolesService(prisma));
  workLogs = new WorkLogsService(
    prisma,
    new ProjectAccessService(prisma),
    new RolesService(prisma),
  );
});

/**
 * 系统角色/权限由 seed 写入，但同一库上其他 spec 会 TRUNCATE system_roles，
 * 因此这里按角色矩阵幂等补齐，保证本文件既可单独跑、也能在全量里跑。
 */
async function ensureSystemRoles(): Promise<void> {
  for (const definition of ROLE_DEFINITIONS) {
    const role = await prisma.systemRole.upsert({
      where: { key: definition.key },
      update: { name: definition.name, requiresMfa: definition.requiresMfa },
      create: {
        key: definition.key,
        name: definition.name,
        requiresMfa: definition.requiresMfa,
      },
    });
    for (const key of definition.permissions) {
      const permission = await prisma.permission.upsert({
        where: { key },
        update: {},
        create: { key, description: key },
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

beforeEach(async () => {
  await truncateAll();
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

async function grantSystemRole(userId: string, roleKey: string): Promise<void> {
  const role = await prisma.systemRole.findUniqueOrThrow({ where: { key: roleKey } });
  await prisma.userSystemRole.create({ data: { userId, systemRoleId: role.id } });
}

async function createProject(number: string): Promise<string> {
  const project = await prisma.project.create({
    data: { number, name: `项目 ${number}`, status: 'ACTIVE' },
  });
  return project.id;
}

async function addMember(userId: string, projectId: string, roles: ProjectRole[]): Promise<void> {
  const membership = await prisma.projectMembership.create({ data: { userId, projectId } });
  for (const role of roles) {
    await prisma.projectMembershipRole.create({ data: { membershipId: membership.id, role } });
  }
}

const range = { from: '2026-11-01', to: '2026-11-07' };

describe('ReportsService (real PostgreSQL)', () => {
  it('counts hours and decisions that match the source rows', async () => {
    const authorId = await createUser('author');
    const approverId = await createUser('approver');
    const managerId = await createUser('manager');
    await grantSystemRole(managerId, 'PROJECT_MANAGER');
    const projectId = await createProject('PRJ-1');
    await addMember(authorId, projectId, ['MEMBER']);
    await addMember(approverId, projectId, ['APPROVER']);
    await addMember(managerId, projectId, ['PROJECT_MANAGER']);

    const first = await workLogs.createDraft(authorId, {
      projectId,
      workDate: '2026-11-02',
      hours: 4,
      completion: '整理需求',
    });
    const submitted = await workLogs.submit(authorId, first.id, { approverId });
    const approvals = new (
      await import('../../src/modules/approvals/approvals.service')
    ).ApprovalsService(prisma, new ProjectAccessService(prisma), new RolesService(prisma));
    await approvals.decide(approverId, submitted.approvalRequestId, {
      decision: 'APPROVED',
      comment: '同意',
    });
    // 第二份：退回。
    const second = await workLogs.createDraft(authorId, {
      projectId,
      workDate: '2026-11-03',
      hours: 2.5,
      completion: '补充说明',
    });
    const submitted2 = await workLogs.submit(authorId, second.id, { approverId });
    await approvals.decide(approverId, submitted2.approvalRequestId, {
      decision: 'RETURNED',
      comment: '再补充',
    });
    // 决策时间是"现在"，而报表按决策时间归入区间；把两条决策钉到区间内，避免用例依赖运行日期。
    await prisma.$executeRawUnsafe(
      `UPDATE "approval_decisions" SET "decided_at" = '2026-11-05T02:00:00Z'`,
    );

    const summary = await reports.summary(managerId, range);

    expect(summary.scope).toBe('PROJECTS');
    expect(summary.hours.total).toBe(6.5);
    expect(summary.approvals.decided).toEqual({ approved: 1, returned: 1, rejected: 0 });
    expect(summary.approvals.returnRate).toBeCloseTo(0.5);
    expect(summary.approvals.pending).toBe(0);

    const byProject = await reports.byProject(managerId, range);
    expect(byProject.items).toEqual([
      expect.objectContaining({ projectId, hours: 6.5, approved: 1, returned: 1, returnRate: 0.5 }),
    ]);
    expect(byProject.truncated).toBe(false);
  });

  it('scopes an employee to their own hours and hides other authors', async () => {
    const employeeId = await createUser('employee');
    const colleagueId = await createUser('colleague');
    const approverId = await createUser('approver');
    const projectId = await createProject('PRJ-1');
    await addMember(employeeId, projectId, ['MEMBER']);
    await addMember(colleagueId, projectId, ['MEMBER']);
    await addMember(approverId, projectId, ['APPROVER']);
    // 只有离开 DRAFT 的日志才计入投入工时。
    const mine = await workLogs.createDraft(employeeId, {
      projectId,
      workDate: '2026-11-02',
      hours: 3,
      completion: '我的工作',
    });
    await workLogs.submit(employeeId, mine.id, { approverId });
    const theirs = await workLogs.createDraft(colleagueId, {
      projectId,
      workDate: '2026-11-02',
      hours: 5,
      completion: '同事的工作',
    });
    await workLogs.submit(colleagueId, theirs.id, { approverId });

    const summary = await reports.summary(employeeId, range);

    expect(summary.scope).toBe('OWN');
    expect(summary.hours.total).toBe(3);
    const rows = await reports.byProject(employeeId, range);
    expect(rows.items).toHaveLength(1);
    expect(rows.items[0]!.hours).toBe(3);
  });

  it('excludes work outside the requested business-day range', async () => {
    const authorId = await createUser('author');
    const approverId = await createUser('approver');
    const projectId = await createProject('PRJ-1');
    await addMember(authorId, projectId, ['MEMBER']);
    await addMember(approverId, projectId, ['APPROVER']);
    const october = await workLogs.createDraft(authorId, {
      projectId,
      workDate: '2026-10-31',
      hours: 7,
      completion: '上个月的工作',
    });
    await workLogs.submit(authorId, october.id, { approverId });
    const november = await workLogs.createDraft(authorId, {
      projectId,
      workDate: '2026-11-02',
      hours: 1,
      completion: '本区间的工作',
    });
    await workLogs.submit(authorId, november.id, { approverId });

    const summary = await reports.summary(authorId, range);

    expect(summary.hours.total).toBe(1);
  });

  it('refuses drilldown without the capability even for a cross-project viewer', async () => {
    const executiveId = await createUser('executive');
    await grantSystemRole(executiveId, 'EXECUTIVE');
    const authorId = await createUser('author');
    const projectId = await createProject('PRJ-1');
    await addMember(authorId, projectId, ['MEMBER']);
    await workLogs.createDraft(authorId, {
      projectId,
      workDate: '2026-11-02',
      hours: 3,
      completion: '明细内容',
    });

    await expect(reports.drilldown(executiveId, projectId, range)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('returns drilldown rows once the capability is granted', async () => {
    const executiveId = await createUser('executive');
    await grantSystemRole(executiveId, 'EXECUTIVE');
    const authorId = await createUser('author');
    const projectId = await createProject('PRJ-1');
    await addMember(authorId, projectId, ['MEMBER']);
    await workLogs.createDraft(authorId, {
      projectId,
      workDate: '2026-11-02',
      hours: 3,
      completion: '明细内容',
    });

    // 模拟"单独授予报表下钻"：临时角色只挂这一条权限。
    const permission = await prisma.permission.upsert({
      where: { key: PERMISSIONS.REPORT_DRILLDOWN },
      update: {},
      create: { key: PERMISSIONS.REPORT_DRILLDOWN, description: '报表下钻' },
    });
    const role = await prisma.systemRole.create({
      data: { key: `DRILLDOWN_${Date.now()}`, name: '临时下钻' },
    });
    await prisma.rolePermission.create({
      data: { systemRoleId: role.id, permissionId: permission.id },
    });
    await prisma.userSystemRole.create({ data: { userId: executiveId, systemRoleId: role.id } });

    const result = await reports.drilldown(executiveId, projectId, range);

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toEqual(
      expect.objectContaining({ hours: 3, completion: '明细内容', author: expect.anything() }),
    );

    await prisma.userSystemRole.deleteMany({ where: { systemRoleId: role.id } });
    await prisma.rolePermission.deleteMany({ where: { systemRoleId: role.id } });
    await prisma.systemRole.delete({ where: { id: role.id } });
  });
});

describe('ReportsService multi-version and boundary cases (real PostgreSQL)', () => {
  it('counts a revised log once, using its current version only', async () => {
    const authorId = await createUser('author');
    const approverId = await createUser('approver');
    const managerId = await createUser('manager');
    await grantSystemRole(managerId, 'PROJECT_MANAGER');
    const projectId = await createProject('PRJ-1');
    await addMember(authorId, projectId, ['MEMBER']);
    await addMember(approverId, projectId, ['APPROVER']);
    await addMember(managerId, projectId, ['PROJECT_MANAGER']);

    const created = await workLogs.createDraft(authorId, {
      projectId,
      workDate: '2026-11-02',
      hours: 4,
      completion: '第一版',
    });
    const submitted = await workLogs.submit(authorId, created.id, { approverId });
    const { ApprovalsService } = await import('../../src/modules/approvals/approvals.service');
    const approvals = new ApprovalsService(
      prisma,
      new ProjectAccessService(prisma),
      new RolesService(prisma),
    );
    await approvals.decide(approverId, submitted.approvalRequestId, {
      decision: 'RETURNED',
      comment: '补充',
    });
    await workLogs.addVersion(authorId, created.id, {
      workDate: '2026-11-02',
      hours: 5,
      completion: '第二版',
    });

    // 退回后新版本仍是 DRAFT：不计入投入工时。
    const draftSummary = await reports.summary(managerId, range);
    expect(draftSummary.hours.total).toBe(0);

    const resubmitted = await workLogs.submit(authorId, created.id, { approverId });
    await approvals.decide(approverId, resubmitted.approvalRequestId, {
      decision: 'APPROVED',
      comment: '同意',
    });

    const summary = await reports.summary(managerId, range);
    // 旧版本 4h 仍留在版本表里，但报表只认当前版本 5h。
    expect(summary.hours.total).toBe(5);
    const versions = await prisma.workLogVersion.count({ where: { workLogId: created.id } });
    expect(versions).toBe(2);
  });

  it('splits decisions on the business-day boundary, not UTC midnight', async () => {
    const authorId = await createUser('author');
    const approverId = await createUser('approver');
    const managerId = await createUser('manager');
    await grantSystemRole(managerId, 'PROJECT_MANAGER');
    const projectId = await createProject('PRJ-1');
    await addMember(authorId, projectId, ['MEMBER']);
    await addMember(approverId, projectId, ['APPROVER']);
    await addMember(managerId, projectId, ['PROJECT_MANAGER']);
    const created = await workLogs.createDraft(authorId, {
      projectId,
      workDate: '2026-11-05',
      hours: 2,
      completion: '边界测试',
    });
    const submitted = await workLogs.submit(authorId, created.id, { approverId });
    const { ApprovalsService } = await import('../../src/modules/approvals/approvals.service');
    const approvals = new ApprovalsService(
      prisma,
      new ProjectAccessService(prisma),
      new RolesService(prisma),
    );
    await approvals.decide(approverId, submitted.approvalRequestId, {
      decision: 'APPROVED',
      comment: '同意',
    });
    // 决策时间人为设到 2026-11-05T13:30Z —— Melbourne 时间已经是 11-06 00:30。
    await prisma.$executeRawUnsafe(
      `UPDATE "approval_decisions" SET "decided_at" = '2026-11-05T13:30:00Z'`,
    );

    const day6 = await reports.summary(managerId, { from: '2026-11-06', to: '2026-11-06' });
    expect(day6.approvals.decided.approved).toBe(1);

    const day5 = await reports.summary(managerId, { from: '2026-11-05', to: '2026-11-05' });
    expect(day5.approvals.decided.approved).toBe(0);
  });

  it('keeps the default range at seven business days across DST', async () => {
    const managerId = await createUser('manager');
    await grantSystemRole(managerId, 'PROJECT_MANAGER');

    const summary = await reports.summary(managerId, {});
    const from = new Date(`${summary.range.from}T00:00:00.000Z`);
    const to = new Date(`${summary.range.to}T00:00:00.000Z`);
    const days = Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;

    expect(days).toBe(7);
  });
});
