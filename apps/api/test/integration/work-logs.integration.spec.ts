import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PrismaService } from '../../src/database/prisma.service';
import type { ProjectRole } from '../../src/generated/prisma/client';
import { ProjectAccessService } from '../../src/modules/project-access/project-access.service';
import { RolesService } from '../../src/modules/roles/roles.service';
import { WorkLogsService } from '../../src/modules/work-logs/work-logs.service';

/**
 * 任务 8 第一片（真实 PostgreSQL）：草稿创建落库。
 *
 * 证明：WorkLog + versionNumber=1 的 WorkLogVersion 在同一事务内创建，
 * currentVersionId 指向该版本，工时按 Decimal(10,2)、work_date 按日期落库，
 * 业务编号唯一；非成员创建被 404 拒绝且不留下任何行。
 */
const prisma = new PrismaService();

const TABLES = [
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

let service: WorkLogsService;

beforeAll(() => {
  service = new WorkLogsService(prisma, new ProjectAccessService(prisma), new RolesService(prisma));
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

const draft = {
  workDate: '2026-11-06',
  hours: 7.5,
  completion: '完成需求梳理并同步接口字段',
};

describe('WorkLogsService.createDraft persistence', () => {
  it('persists the log, its first version and the current version pointer atomically', async () => {
    const userId = await createUser('member');
    const projectId = await createProject();
    await addMember(userId, projectId, ['MEMBER']);

    const created = await service.createDraft(userId, { ...draft, projectId });

    const stored = await prisma.workLog.findUniqueOrThrow({
      where: { id: created.id },
      include: { currentVersion: true, versions: true },
    });
    expect(stored.status).toBe('DRAFT');
    expect(stored.visibility).toBe('PRIVATE');
    expect(stored.version).toBe(1);
    expect(stored.number).toMatch(/^WL-20261106-[0-9A-F]{8}$/);
    expect(stored.currentVersionId).toBe(stored.versions[0]!.id);
    expect(stored.versions).toHaveLength(1);
    expect(stored.currentVersion?.versionNumber).toBe(1);
    expect(stored.currentVersion?.hours.toString()).toBe('7.5');
    expect(stored.currentVersion?.workDate.toISOString().slice(0, 10)).toBe('2026-11-06');
    expect(stored.currentVersion?.completion).toBe(draft.completion);
  });

  it('rejects a non-member with 404 and stores nothing', async () => {
    const userId = await createUser('outsider');
    const projectId = await createProject();

    await expect(service.createDraft(userId, { ...draft, projectId })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(await prisma.workLog.count()).toBe(0);
    expect(await prisma.workLogVersion.count()).toBe(0);
  });

  it('issues a distinct business number for every log', async () => {
    const userId = await createUser('member');
    const projectId = await createProject();
    await addMember(userId, projectId, ['MEMBER']);

    const first = await service.createDraft(userId, { ...draft, projectId });
    const second = await service.createDraft(userId, { ...draft, projectId });

    expect(first.number).not.toBe(second.number);
    expect(await prisma.workLog.count()).toBe(2);
  });

  it('persists PROJECT_VISIBLE for a project manager', async () => {
    const userId = await createUser('manager');
    const projectId = await createProject();
    await addMember(userId, projectId, ['PROJECT_MANAGER']);

    const created = await service.createDraft(userId, {
      ...draft,
      projectId,
      visibility: 'PROJECT_VISIBLE',
    });

    const stored = await prisma.workLog.findUniqueOrThrow({ where: { id: created.id } });
    expect(stored.visibility).toBe('PROJECT_VISIBLE');
  });
});

describe('WorkLogsService.submit persistence', () => {
  async function seedLog() {
    const authorId = await createUser('author');
    const approverId = await createUser('approver');
    const projectId = await createProject();
    await addMember(authorId, projectId, ['MEMBER']);
    await addMember(approverId, projectId, ['APPROVER']);
    const created = await service.createDraft(authorId, { ...draft, projectId });
    return { authorId, approverId, projectId, workLogId: created.id };
  }

  it('writes SUBMITTED plus a PENDING approval request bound to the frozen version', async () => {
    const { authorId, approverId, workLogId } = await seedLog();

    const result = await service.submit(authorId, workLogId, { approverId });

    const stored = await prisma.workLog.findUniqueOrThrow({ where: { id: workLogId } });
    expect(stored.status).toBe('SUBMITTED');
    expect(stored.version).toBe(2);
    const request = await prisma.approvalRequest.findUniqueOrThrow({
      where: { id: result.approvalRequestId },
    });
    expect(request.workLogVersionId).toBe(stored.currentVersionId);
    expect(request.submitterId).toBe(authorId);
    expect(request.approverId).toBe(approverId);
    expect(request.status).toBe('PENDING');
    expect(request.processedAt).toBeNull();
  });

  it('rejects a second submission of the same log', async () => {
    const { authorId, approverId, workLogId } = await seedLog();
    await service.submit(authorId, workLogId, { approverId });

    await expect(service.submit(authorId, workLogId, { approverId })).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(await prisma.approvalRequest.count()).toBe(1);
  });

  it('rejects self-approval before writing anything', async () => {
    const { authorId, workLogId } = await seedLog();

    await expect(
      service.submit(authorId, workLogId, { approverId: authorId }),
    ).rejects.toBeInstanceOf(BadRequestException);
    const stored = await prisma.workLog.findUniqueOrThrow({ where: { id: workLogId } });
    expect(stored.status).toBe('DRAFT');
    expect(await prisma.approvalRequest.count()).toBe(0);
  });

  it('rejects submitting a log that was returned for changes', async () => {
    const { authorId, approverId, workLogId } = await seedLog();
    await prisma.workLog.update({ where: { id: workLogId }, data: { status: 'RETURNED' } });

    await expect(service.submit(authorId, workLogId, { approverId })).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(await prisma.approvalRequest.count()).toBe(0);
  });

  it('rejects an approver who is not an active project member', async () => {
    const { authorId, workLogId } = await seedLog();
    const outsiderId = await createUser('outsider');

    // 防枚举口径与 assertProjectAccess 一致：审批人不合格与不存在同为 404。
    await expect(
      service.submit(authorId, workLogId, { approverId: outsiderId }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(await prisma.approvalRequest.count()).toBe(0);
  });

  it('keeps only one approval request under concurrent submissions', async () => {
    const { authorId, approverId, workLogId } = await seedLog();

    const outcomes = await Promise.allSettled([
      service.submit(authorId, workLogId, { approverId }),
      service.submit(authorId, workLogId, { approverId }),
    ]);

    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.approvalRequest.count()).toBe(1);
  });
});
