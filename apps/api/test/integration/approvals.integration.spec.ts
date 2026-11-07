import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PrismaService } from '../../src/database/prisma.service';
import type { ProjectRole } from '../../src/generated/prisma/client';
import { ApprovalsService } from '../../src/modules/approvals/approvals.service';
import { ProjectAccessService } from '../../src/modules/project-access/project-access.service';
import { RolesService } from '../../src/modules/roles/roles.service';
import { WorkLogsService } from '../../src/modules/work-logs/work-logs.service';

/**
 * 任务 9 单级审批（真实 PostgreSQL）。
 *
 * 重点证明四件事：
 *  1. 通过/退回/拒绝都在同一事务内改审批请求、日志状态、事件、通知与邮件出站行；
 *  2. 只有被指定的审批人能决策，自审被拒；
 *  3. 重复/并发决策只有一次成功，第二次 409 且不产生第二条决策；
 *  4. **审批请求绑定的版本必须仍是当前版本**——否则 409（review-12 重指向风险的归宿）。
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
  const joined = TABLES.map((t) => `"${t}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${joined} RESTART IDENTITY CASCADE`);
}

let workLogs: WorkLogsService;
let approvals: ApprovalsService;

beforeAll(() => {
  workLogs = new WorkLogsService(
    prisma,
    new ProjectAccessService(prisma),
    new RolesService(prisma),
  );
  approvals = new ApprovalsService(
    prisma,
    new ProjectAccessService(prisma),
    new RolesService(prisma),
  );
});

beforeEach(async () => {
  await truncateAll();
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

async function createProject(number = 'PRJ-0001'): Promise<string> {
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

const draft = { workDate: '2026-11-06', hours: 4, completion: '完成需求梳理' };

async function seedSubmitted() {
  const authorId = await createUser('author');
  const approverId = await createUser('approver');
  const projectId = await createProject();
  await addMember(authorId, projectId, ['MEMBER']);
  await addMember(approverId, projectId, ['APPROVER']);
  const created = await workLogs.createDraft(authorId, { ...draft, projectId });
  const submitted = await workLogs.submit(authorId, created.id, { approverId });
  return {
    authorId,
    approverId,
    projectId,
    workLogId: created.id,
    approvalId: submitted.approvalRequestId,
  };
}

describe('ApprovalsService.decide (real PostgreSQL)', () => {
  it('approves a submitted log and records event, notification and outbox rows', async () => {
    const { authorId, approverId, projectId, workLogId, approvalId } = await seedSubmitted();

    const result = await approvals.decide(approverId, approvalId, {
      decision: 'APPROVED',
      comment: '同意',
    });

    expect(result).toEqual({ id: approvalId, status: 'APPROVED', workLogStatus: 'APPROVED' });

    const log = await prisma.workLog.findUniqueOrThrow({ where: { id: workLogId } });
    expect(log.status).toBe('APPROVED');

    const request = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: approvalId } });
    expect(request.status).toBe('APPROVED');
    expect(request.processedAt).not.toBeNull();

    const decisions = await prisma.approvalDecision.findMany({
      where: { approvalRequestId: approvalId },
    });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.decision).toBe('APPROVED');
    expect(decisions[0]!.decidedById).toBe(approverId);
    expect(decisions[0]!.comment).toBe('同意');

    const events = await prisma.projectEvent.findMany({ where: { projectId } });
    expect(events.map((e) => e.eventType)).toContain('WORK_LOG_APPROVED');

    const notifications = await prisma.notification.findMany({ where: { userId: authorId } });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.resourceId).toBe(workLogId);
    expect(notifications[0]!.status).toBe('UNREAD');

    const outbox = await prisma.emailOutbox.findMany();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.toAddress).toBe('author@example.test');
  });

  it('returns a log with a mandatory comment and keeps the version frozen', async () => {
    const { approverId, workLogId, approvalId } = await seedSubmitted();

    await expect(
      approvals.decide(approverId, approvalId, { decision: 'RETURNED', comment: '  ' }),
    ).rejects.toBeInstanceOf(BadRequestException);

    await approvals.decide(approverId, approvalId, { decision: 'RETURNED', comment: '补充进度' });

    const log = await prisma.workLog.findUniqueOrThrow({ where: { id: workLogId } });
    expect(log.status).toBe('RETURNED');
    const versions = await prisma.workLogVersion.findMany({ where: { workLogId } });
    expect(versions).toHaveLength(1);
    expect(versions[0]!.frozenAt).not.toBeNull();
  });

  it('rejects a decision from anyone other than the designated approver', async () => {
    const { projectId, approvalId } = await seedSubmitted();
    const outsiderId = await createUser('outsider');
    await addMember(outsiderId, projectId, ['APPROVER']);

    await expect(
      approvals.decide(outsiderId, approvalId, { decision: 'APPROVED' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(await prisma.approvalDecision.count()).toBe(0);
  });

  it('refuses a second decision and keeps exactly one decision row', async () => {
    const { approverId, approvalId } = await seedSubmitted();
    await approvals.decide(approverId, approvalId, { decision: 'APPROVED' });

    await expect(
      approvals.decide(approverId, approvalId, { decision: 'RETURNED', comment: '反悔' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(await prisma.approvalDecision.count()).toBe(1);
  });

  it('refuses when the approval points at a version that is no longer current', async () => {
    // 走合法路径造出"v2 是当前版本、v1 上还挂着一份 PENDING 审批"的局面：
    // 提交 v1 → 退回 → 开 v2 → 再提交 v2，然后把 v1 上那份已处理的请求换成新的 PENDING。
    const authorId = await createUser('author');
    const approverId = await createUser('approver');
    const projectId = await createProject();
    await addMember(authorId, projectId, ['MEMBER']);
    await addMember(approverId, projectId, ['APPROVER']);
    const created = await workLogs.createDraft(authorId, { ...draft, projectId });
    const first = await workLogs.submit(authorId, created.id, { approverId });
    await approvals.decide(approverId, first.approvalRequestId, {
      decision: 'RETURNED',
      comment: '补充进度',
    });
    await workLogs.addVersion(authorId, created.id, { ...draft, completion: '补充后的内容' });
    const second = await workLogs.submit(authorId, created.id, { approverId });
    const v1 = await prisma.workLogVersion.findFirstOrThrow({
      where: { workLogId: created.id, versionNumber: 1 },
    });

    // 旧版本上的请求行已被处理（决策行以 RESTRICT 引用它，先删决策再删请求），
    // 换一条新的 PENDING，模拟历史遗留的重指向数据。
    await prisma.approvalDecision.deleteMany({
      where: { approvalRequestId: first.approvalRequestId },
    });
    await prisma.approvalRequest.delete({ where: { id: first.approvalRequestId } });
    const stale = await prisma.approvalRequest.create({
      data: {
        workLogVersionId: v1.id,
        approverId,
        submitterId: authorId,
        status: 'PENDING',
      },
    });

    await expect(
      approvals.decide(approverId, stale.id, { decision: 'APPROVED' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(await prisma.approvalDecision.count({ where: { approvalRequestId: stale.id } })).toBe(0);

    const log = await prisma.workLog.findUniqueOrThrow({ where: { id: created.id } });
    expect(log.status).toBe('SUBMITTED');
    expect(log.currentVersionId).not.toBe(v1.id);
    expect(await prisma.notification.count()).toBe(1); // 只有第一步"退回"的通知
    // 当前版本上的审批请求仍然可正常决策。
    await approvals.decide(approverId, second.approvalRequestId, { decision: 'APPROVED' });
  });

  it('lets only one of two concurrent decisions win', async () => {
    const { approverId, workLogId, approvalId } = await seedSubmitted();

    const results = await Promise.allSettled([
      approvals.decide(approverId, approvalId, { decision: 'APPROVED' }),
      approvals.decide(approverId, approvalId, { decision: 'RETURNED', comment: '改一下' }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(await prisma.approvalDecision.count()).toBe(1);
    const log = await prisma.workLog.findUniqueOrThrow({ where: { id: workLogId } });
    expect(['APPROVED', 'RETURNED']).toContain(log.status);
    expect(await prisma.notification.count()).toBe(1);
  });

  it('lists only the approver own pending requests', async () => {
    const first = await seedSubmitted();
    const otherApproverId = await createUser('approver-2');
    await addMember(otherApproverId, first.projectId, ['APPROVER']);
    const authorTwo = await createUser('author-2');
    await addMember(authorTwo, first.projectId, ['MEMBER']);
    const secondLog = await workLogs.createDraft(authorTwo, {
      ...draft,
      projectId: first.projectId,
    });
    await workLogs.submit(authorTwo, secondLog.id, { approverId: otherApproverId });

    const page = await approvals.listPending(first.approverId, { page: 1, pageSize: 10 });

    expect(page.total).toBe(1);
    expect(page.items[0]!.workLogVersion.workLog.id).toBe(first.workLogId);
  });

  it('cannot even forge a self-approval row: the database rejects it', async () => {
    const { authorId, approvalId } = await seedSubmitted();

    // 自审在数据层就被 check constraint 挡住，服务层的 ForbiddenException 只是纵深防御。
    await expect(
      prisma.approvalRequest.update({
        where: { id: approvalId },
        data: { approverId: authorId },
      }),
    ).rejects.toThrow(/approval_requests_no_self_approval/);
    expect(await prisma.approvalDecision.count()).toBe(0);
  });
});

describe('ApprovalsService authorization revocation (real PostgreSQL)', () => {
  it('refuses a decision once the approver was removed from the project', async () => {
    const { approverId, projectId, workLogId, approvalId } = await seedSubmitted();
    const membership = await prisma.projectMembership.findFirstOrThrow({
      where: { userId: approverId, projectId },
    });
    await prisma.projectMembershipRole.deleteMany({ where: { membershipId: membership.id } });
    await prisma.projectMembership.delete({ where: { id: membership.id } });

    await expect(
      approvals.decide(approverId, approvalId, { decision: 'APPROVED' }),
    ).rejects.toBeInstanceOf(NotFoundException);

    const log = await prisma.workLog.findUniqueOrThrow({ where: { id: workLogId } });
    expect(log.status).toBe('SUBMITTED');
    expect(await prisma.approvalDecision.count()).toBe(0);
    expect(await prisma.notification.count()).toBe(0);
  });

  it('refuses a decision once the approver role was downgraded to MEMBER', async () => {
    const { approverId, projectId, approvalId } = await seedSubmitted();
    const membership = await prisma.projectMembership.findFirstOrThrow({
      where: { userId: approverId, projectId },
    });
    await prisma.projectMembershipRole.deleteMany({ where: { membershipId: membership.id } });
    await prisma.projectMembershipRole.create({
      data: { membershipId: membership.id, role: 'MEMBER' },
    });

    await expect(
      approvals.decide(approverId, approvalId, { decision: 'APPROVED' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(await prisma.approvalDecision.count()).toBe(0);
  });

  it('rolls the whole decision back when the notification cannot be written', async () => {
    const { approverId, workLogId, approvalId } = await seedSubmitted();

    await prisma.$executeRawUnsafe(
      'ALTER TABLE "notifications" ADD CONSTRAINT "notifications_probe_block" CHECK (false)',
    );
    try {
      await expect(
        approvals.decide(approverId, approvalId, { decision: 'APPROVED' }),
      ).rejects.toBeTruthy();

      const log = await prisma.workLog.findUniqueOrThrow({ where: { id: workLogId } });
      expect(log.status).toBe('SUBMITTED');
      const request = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: approvalId } });
      expect(request.status).toBe('PENDING');
      expect(await prisma.approvalDecision.count()).toBe(0);
      expect(await prisma.emailOutbox.count()).toBe(0);
    } finally {
      await prisma.$executeRawUnsafe(
        'ALTER TABLE "notifications" DROP CONSTRAINT IF EXISTS "notifications_probe_block"',
      );
    }
  });
});

describe('ApprovalsService.listPending scoping (real PostgreSQL)', () => {
  it('marks a fresh request decidable and a stale one not decidable', async () => {
    const authorId = await createUser('author');
    const approverId = await createUser('approver');
    const projectId = await createProject();
    await addMember(authorId, projectId, ['MEMBER']);
    await addMember(approverId, projectId, ['APPROVER']);
    const created = await workLogs.createDraft(authorId, { ...draft, projectId });
    const first = await workLogs.submit(authorId, created.id, { approverId });
    await approvals.decide(approverId, first.approvalRequestId, {
      decision: 'RETURNED',
      comment: '补充进度',
    });
    await workLogs.addVersion(authorId, created.id, { ...draft, completion: '补充后的内容' });
    const second = await workLogs.submit(authorId, created.id, { approverId });

    const fresh = await approvals.listPending(approverId, { page: 1, pageSize: 10 });
    expect(fresh.total).toBe(1);
    expect(fresh.items[0]!.id).toBe(second.approvalRequestId);
    expect(fresh.items[0]!.canDecide).toBe(true);

    // 造一条指向旧版本、日志已在等新版本的 PENDING 请求：可见但不可决策。
    const v1 = await prisma.workLogVersion.findFirstOrThrow({
      where: { workLogId: created.id, versionNumber: 1 },
    });
    await prisma.approvalDecision.deleteMany({
      where: { approvalRequestId: first.approvalRequestId },
    });
    await prisma.approvalRequest.delete({ where: { id: first.approvalRequestId } });
    const stale = await prisma.approvalRequest.create({
      data: { workLogVersionId: v1.id, approverId, submitterId: authorId, status: 'PENDING' },
    });

    const page = await approvals.listPending(approverId, { page: 1, pageSize: 10 });
    const staleItem = page.items.find((item) => item.id === stale.id);
    expect(staleItem).toBeDefined();
    expect(staleItem!.canDecide).toBe(false);
    const freshItem = page.items.find((item) => item.id === second.approvalRequestId);
    expect(freshItem!.canDecide).toBe(true);
  });

  it('hides pending requests from an approver who was removed from the project', async () => {
    const { approverId, projectId } = await seedSubmitted();
    const membership = await prisma.projectMembership.findFirstOrThrow({
      where: { userId: approverId, projectId },
    });
    await prisma.projectMembershipRole.deleteMany({ where: { membershipId: membership.id } });
    await prisma.projectMembership.delete({ where: { id: membership.id } });

    const page = await approvals.listPending(approverId, { page: 1, pageSize: 10 });

    expect(page.total).toBe(0);
    expect(page.items).toHaveLength(0);
  });

  it('hides pending requests from an approver downgraded to MEMBER', async () => {
    const { approverId, projectId } = await seedSubmitted();
    const membership = await prisma.projectMembership.findFirstOrThrow({
      where: { userId: approverId, projectId },
    });
    await prisma.projectMembershipRole.deleteMany({ where: { membershipId: membership.id } });
    await prisma.projectMembershipRole.create({
      data: { membershipId: membership.id, role: 'MEMBER' },
    });

    const page = await approvals.listPending(approverId, { page: 1, pageSize: 10 });
    expect(page.total).toBe(0);
  });
});

describe('ApprovalsService archived projects and soft delete (real PostgreSQL)', () => {
  it('hides and refuses pending approvals once the project is archived', async () => {
    const { approverId, projectId, workLogId, approvalId } = await seedSubmitted();
    await prisma.project.update({ where: { id: projectId }, data: { status: 'ARCHIVED' } });

    const page = await approvals.listPending(approverId, { page: 1, pageSize: 10 });
    expect(page.total).toBe(0);

    await expect(
      approvals.decide(approverId, approvalId, { decision: 'APPROVED' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    const log = await prisma.workLog.findUniqueOrThrow({ where: { id: workLogId } });
    expect(log.status).toBe('SUBMITTED');
    expect(await prisma.approvalDecision.count()).toBe(0);
  });

  it('hides pending approvals for a suspended approver account', async () => {
    const { approverId, approvalId } = await seedSubmitted();
    await prisma.user.update({ where: { id: approverId }, data: { status: 'SUSPENDED' } });

    const page = await approvals.listPending(approverId, { page: 1, pageSize: 10 });
    expect(page.total).toBe(0);
    await expect(
      approvals.decide(approverId, approvalId, { decision: 'APPROVED' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('hides pending approvals for a soft-deleted work log', async () => {
    const { approverId, workLogId } = await seedSubmitted();
    await prisma.workLog.update({ where: { id: workLogId }, data: { deletedAt: new Date() } });

    const page = await approvals.listPending(approverId, { page: 1, pageSize: 10 });
    expect(page.total).toBe(0);
  });

  it('refuses a decision when the approver was downgraded before the decision (pre-transaction gate)', async () => {
    const { approverId, projectId, workLogId, approvalId } = await seedSubmitted();
    const membership = await prisma.projectMembership.findFirstOrThrow({
      where: { userId: approverId, projectId },
    });

    // 事务外闸门：降级后连事务都不会开始（事务内复查由单测覆盖）。
    await prisma.projectMembershipRole.deleteMany({ where: { membershipId: membership.id } });
    await prisma.projectMembershipRole.create({
      data: { membershipId: membership.id, role: 'MEMBER' },
    });

    await expect(
      approvals.decide(approverId, approvalId, { decision: 'APPROVED' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    const log = await prisma.workLog.findUniqueOrThrow({ where: { id: workLogId } });
    expect(log.status).toBe('SUBMITTED');
    expect(await prisma.approvalDecision.count()).toBe(0);
    expect(await prisma.emailOutbox.count()).toBe(0);
  });
});

describe('ApprovalsService project status semantics (real PostgreSQL)', () => {
  for (const status of ['DRAFT', 'ON_HOLD', 'COMPLETED'] as const) {
    it(`keeps approvals visible and decidable while the project is ${status}`, async () => {
      const { approverId, projectId, approvalId } = await seedSubmitted();
      await prisma.project.update({ where: { id: projectId }, data: { status } });

      const page = await approvals.listPending(approverId, { page: 1, pageSize: 10 });
      expect(page.total).toBe(1);
      expect(page.items[0]!.canDecide).toBe(true);

      await expect(
        approvals.decide(approverId, approvalId, { decision: 'APPROVED' }),
      ).resolves.toEqual(expect.objectContaining({ status: 'APPROVED' }));
    });
  }

  it('refuses to decide a soft-deleted work log', async () => {
    const { approverId, workLogId, approvalId } = await seedSubmitted();
    await prisma.workLog.update({ where: { id: workLogId }, data: { deletedAt: new Date() } });

    await expect(
      approvals.decide(approverId, approvalId, { decision: 'APPROVED' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(await prisma.approvalDecision.count()).toBe(0);
  });
});
