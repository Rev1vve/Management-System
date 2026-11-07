import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
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
    await service.submit(authorId, workLogId, { approverId });
    // 状态机只在数据库层允许 SUBMITTED -> RETURNED。
    await prisma.workLog.update({ where: { id: workLogId }, data: { status: 'RETURNED' } });

    const requestsAfterFirstSubmit = await prisma.approvalRequest.count();
    await expect(service.submit(authorId, workLogId, { approverId })).rejects.toBeInstanceOf(
      ConflictException,
    );
    // 被拒绝的重复提交不得再生成审批请求。
    expect(await prisma.approvalRequest.count()).toBe(requestsAfterFirstSubmit);
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

describe('WorkLogsService versions (real PostgreSQL)', () => {
  async function seedReturned() {
    const authorId = await createUser('author');
    const approverId = await createUser('approver');
    const projectId = await createProject();
    await addMember(authorId, projectId, ['MEMBER']);
    await addMember(approverId, projectId, ['APPROVER']);
    const created = await service.createDraft(authorId, { ...draft, projectId });
    await service.submit(authorId, created.id, { approverId });
    await prisma.workLog.update({ where: { id: created.id }, data: { status: 'RETURNED' } });
    return { authorId, projectId, workLogId: created.id };
  }

  it('adds versionNumber max+1 and leaves the previous version and approval history untouched', async () => {
    const { authorId, workLogId } = await seedReturned();
    const before = await prisma.workLogVersion.findMany({
      where: { workLogId },
      orderBy: { versionNumber: 'asc' },
    });
    const approvalsBefore = await prisma.approvalRequest.findMany({ where: {} });

    const result = await service.addVersion(authorId, workLogId, {
      workDate: '2026-11-07',
      hours: 4.25,
      completion: '按退回意见补充交付清单',
    });

    expect(result).toEqual({
      id: workLogId,
      status: 'DRAFT',
      versionNumber: before.length + 1,
      // createDraft=v1 → submit(+1)=2 → addVersion(+1)=3
      version: 3,
    });
    const after = await prisma.workLogVersion.findMany({
      where: { workLogId },
      orderBy: { versionNumber: 'asc' },
    });
    expect(after).toHaveLength(before.length + 1);
    // 旧版本逐字段不变
    expect(after.slice(0, before.length)).toEqual(before);
    const log = await prisma.workLog.findUniqueOrThrow({ where: { id: workLogId } });
    expect(log.status).toBe('DRAFT');
    expect(log.currentVersionId).toBe(after.at(-1)!.id);
    // 审批历史一行不改
    expect(await prisma.approvalRequest.findMany({ where: {} })).toEqual(approvalsBefore);
  });

  it('keeps only one new version under concurrent addVersion calls', async () => {
    const { authorId, workLogId } = await seedReturned();
    const content = { workDate: '2026-11-07', hours: 2, completion: '并发' };

    const outcomes = await Promise.allSettled([
      service.addVersion(authorId, workLogId, content),
      service.addVersion(authorId, workLogId, content),
    ]);

    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter((o) => o.status === 'rejected') as PromiseRejectedResult[];
    expect(fulfilled).toHaveLength(1);
    // 失败方必须是 409，不能把 P2002 漏成 500。
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(ConflictException);
    const versions = await prisma.workLogVersion.findMany({ where: { workLogId } });
    expect(versions).toHaveLength(2);
  });

  it('edits the current draft version and bumps the optimistic version', async () => {
    const authorId = await createUser('author');
    const projectId = await createProject();
    await addMember(authorId, projectId, ['MEMBER']);
    const created = await service.createDraft(authorId, { ...draft, projectId });

    await service.updateDraft(
      authorId,
      created.id,
      { workDate: '2026-11-08', hours: 3.75, completion: '草稿编辑后的内容' },
      1,
    );

    const log = await prisma.workLog.findUniqueOrThrow({
      where: { id: created.id },
      include: { currentVersion: true },
    });
    expect(log.version).toBe(2);
    expect(log.currentVersion?.completion).toBe('草稿编辑后的内容');
    expect(log.currentVersion?.hours.toString()).toBe('3.75');
    expect(await prisma.workLogVersion.count({ where: { workLogId: created.id } })).toBe(1);
  });

  it('refuses to edit a submitted log', async () => {
    const authorId = await createUser('author');
    const approverId = await createUser('approver');
    const projectId = await createProject();
    await addMember(authorId, projectId, ['MEMBER']);
    await addMember(approverId, projectId, ['APPROVER']);
    const created = await service.createDraft(authorId, { ...draft, projectId });
    await service.submit(authorId, created.id, { approverId });

    await expect(
      service.updateDraft(
        authorId,
        created.id,
        { workDate: '2026-11-08', hours: 1, completion: '不应生效' },
        1,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    const log = await prisma.workLog.findUniqueOrThrow({
      where: { id: created.id },
      include: { currentVersion: true },
    });
    expect(log.currentVersion?.completion).toBe(draft.completion);
  });

  it('lets only one of two concurrent draft edits win (optimistic version)', async () => {
    const authorId = await createUser('author');
    const projectId = await createProject();
    await addMember(authorId, projectId, ['MEMBER']);
    const created = await service.createDraft(authorId, { ...draft, projectId });
    const base = { workDate: '2026-11-08', hours: 2, completion: 'edit-A' };

    const outcomes = await Promise.allSettled([
      service.updateDraft(authorId, created.id, base, 1),
      service.updateDraft(authorId, created.id, { ...base, completion: 'edit-B' }, 1),
    ]);

    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.filter((o) => o.status === 'rejected') as PromiseRejectedResult[];
    expect(rejected[0]!.reason).toBeInstanceOf(ConflictException);
    // 版次只前进一次，落库内容必须是获胜方写的，不能出现"两个都成功、后者覆盖前者"。
    const log = await prisma.workLog.findUniqueOrThrow({
      where: { id: created.id },
      include: { currentVersion: true },
    });
    expect(log.version).toBe(2);
    expect(['edit-A', 'edit-B']).toContain(log.currentVersion?.completion);
  });

  it('returns 404 for another user editing or adding versions', async () => {
    const authorId = await createUser('author');
    const outsiderId = await createUser('outsider');
    const projectId = await createProject();
    await addMember(authorId, projectId, ['MEMBER']);
    const created = await service.createDraft(authorId, { ...draft, projectId });

    await expect(
      service.updateDraft(outsiderId, created.id, { ...draft }, 1),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.addVersion(outsiderId, created.id, { ...draft })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('persists the order reference and clears a stale item link (real PostgreSQL)', async () => {
    const authorId = await createUser('author');
    const projectId = await createProject();
    await addMember(authorId, projectId, ['MEMBER']);
    const order = await prisma.order.create({
      data: { number: 'ORD-0001', projectId, title: '订单甲', status: 'ACTIVE' },
    });
    const item = await prisma.orderItem.create({
      data: { orderId: order.id, name: '交付项', quantity: 1, unit: '件' },
    });
    const created = await service.createDraft(authorId, {
      ...draft,
      projectId,
      orderId: order.id,
      orderItemId: item.id,
    });
    const withItem = await prisma.workLog.findUniqueOrThrow({ where: { id: created.id } });
    expect(withItem.orderId).toBe(order.id);
    expect(withItem.orderItemId).toBe(item.id);

    // 只给 orderId → 旧的 orderItemId 必须被清空，不能留下跨订单引用。
    await service.updateDraft(authorId, created.id, { ...draft, orderId: order.id }, 1);

    const cleared = await prisma.workLog.findUniqueOrThrow({ where: { id: created.id } });
    expect(cleared.orderId).toBe(order.id);
    expect(cleared.orderItemId).toBeNull();
  });

  it('rejects another member of the same project with 404 (author filter, not membership)', async () => {
    const authorId = await createUser('author');
    const peerId = await createUser('peer');
    const projectId = await createProject();
    await addMember(authorId, projectId, ['MEMBER']);
    await addMember(peerId, projectId, ['MEMBER', 'PROJECT_MANAGER']);
    const created = await service.createDraft(authorId, { ...draft, projectId });

    await expect(service.updateDraft(peerId, created.id, { ...draft }, 1)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.getDetail(peerId, created.id)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('exposes the optimistic version token through the detail endpoint', async () => {
    const authorId = await createUser('author');
    const projectId = await createProject();
    await addMember(authorId, projectId, ['MEMBER']);
    const created = await service.createDraft(authorId, { ...draft, projectId });

    const detail = await service.getDetail(authorId, created.id);
    expect(detail.version).toBe(1);
    expect(detail.currentVersion?.versionNumber).toBe(1);

    await service.updateDraft(authorId, created.id, { ...draft, hours: 2 }, detail.version!);
    expect((await service.getDetail(authorId, created.id)).version).toBe(2);
  });
});

/**
 * D-C：数据库层的归属与不可变约束（VERTICAL-4）。
 * 这些用例直接打 Prisma/SQL，绕过 service，证明"即使应用层写错也写不进去"。
 */
describe('work log version guards (database level)', () => {
  async function seedTwoDrafts() {
    const authorId = await createUser('author');
    const projectId = await createProject();
    await addMember(authorId, projectId, ['MEMBER']);
    const a = await service.createDraft(authorId, { ...draft, projectId });
    const b = await service.createDraft(authorId, { ...draft, projectId });
    const versionB = await prisma.workLogVersion.findFirstOrThrow({ where: { workLogId: b.id } });
    const versionA = await prisma.workLogVersion.findFirstOrThrow({ where: { workLogId: a.id } });
    return { authorId, projectId, logA: a.id, logB: b.id, versionA, versionB };
  }

  it('rejects pointing currentVersionId at another work log version', async () => {
    const { logA, versionB } = await seedTwoDrafts();

    await expect(
      prisma.$executeRaw`UPDATE "work_logs" SET "current_version_id" = ${versionB.id} WHERE "id" = ${logA}`,
    ).rejects.toThrow(/current version must belong to the same work log/);
  });

  it('rejects editing a historical version because it is frozen', async () => {
    const authorId = await createUser('author');
    const approverId = await createUser('approver');
    const projectId = await createProject();
    await addMember(authorId, projectId, ['MEMBER']);
    await addMember(approverId, projectId, ['APPROVER']);
    const created = await service.createDraft(authorId, { ...draft, projectId });
    await service.submit(authorId, created.id, { approverId });
    await prisma.workLog.update({ where: { id: created.id }, data: { status: 'RETURNED' } });
    const historical = await prisma.workLogVersion.findFirstOrThrow({
      where: { workLogId: created.id },
    });
    await service.addVersion(authorId, created.id, { ...draft, completion: '新版本' });

    await expect(
      prisma.$executeRaw`UPDATE "work_log_versions" SET "completion" = '篡改' WHERE "id" = ${historical.id}`,
    ).rejects.toThrow(/work log version is frozen and cannot be edited/);
  });

  it('rejects editing the current version once the log left DRAFT', async () => {
    const authorId = await createUser('author');
    const approverId = await createUser('approver');
    const projectId = await createProject();
    await addMember(authorId, projectId, ['MEMBER']);
    await addMember(approverId, projectId, ['APPROVER']);
    const created = await service.createDraft(authorId, { ...draft, projectId });
    const current = await prisma.workLogVersion.findFirstOrThrow({
      where: { workLogId: created.id },
    });
    await service.submit(authorId, created.id, { approverId });

    await expect(
      prisma.$executeRaw`UPDATE "work_log_versions" SET "completion" = '篡改' WHERE "id" = ${current.id}`,
    ).rejects.toThrow(/work log version is frozen and cannot be edited/);
  });

  it('allows editing the current version while the log is DRAFT', async () => {
    const authorId = await createUser('author');
    const projectId = await createProject();
    await addMember(authorId, projectId, ['MEMBER']);
    const created = await service.createDraft(authorId, { ...draft, projectId });
    const current = await prisma.workLogVersion.findFirstOrThrow({
      where: { workLogId: created.id },
    });

    await prisma.workLogVersion.update({
      where: { id: current.id },
      data: { completion: '草稿允许直接改' },
    });
    await service.updateDraft(authorId, created.id, { ...draft, hours: 3 }, 1);

    const stored = await prisma.workLogVersion.findUniqueOrThrow({ where: { id: current.id } });
    expect(stored.completion).toBe(draft.completion);
  });

  it('rejects altering the version structure', async () => {
    const { versionA } = await seedTwoDrafts();

    await expect(
      prisma.$executeRaw`UPDATE "work_log_versions" SET "version_number" = 9 WHERE "id" = ${versionA.id}`,
    ).rejects.toThrow(/work log version structure is immutable/);
  });

  it('rejects hard-deleting a version', async () => {
    const { versionA } = await seedTwoDrafts();

    await expect(
      prisma.$executeRaw`DELETE FROM "work_log_versions" WHERE "id" = ${versionA.id}`,
    ).rejects.toThrow(/append-only/);
  });

  it('rejects an illegal status transition (rewinding to DRAFT)', async () => {
    const authorId = await createUser('author');
    const approverId = await createUser('approver');
    const projectId = await createProject();
    await addMember(authorId, projectId, ['MEMBER']);
    await addMember(approverId, projectId, ['APPROVER']);
    const created = await service.createDraft(authorId, { ...draft, projectId });
    await service.submit(authorId, created.id, { approverId });

    await expect(
      prisma.$executeRaw`UPDATE "work_logs" SET "status" = 'DRAFT' WHERE "id" = ${created.id}`,
    ).rejects.toThrow(/illegal work log status transition/);
    const stored = await prisma.workLog.findUniqueOrThrow({ where: { id: created.id } });
    expect(stored.status).toBe('SUBMITTED');
  });

  it('freezes the current version on submit so it can never be edited again', async () => {
    const authorId = await createUser('author');
    const approverId = await createUser('approver');
    const projectId = await createProject();
    await addMember(authorId, projectId, ['MEMBER']);
    await addMember(approverId, projectId, ['APPROVER']);
    const created = await service.createDraft(authorId, { ...draft, projectId });
    const current = await prisma.workLogVersion.findFirstOrThrow({
      where: { workLogId: created.id },
    });
    expect(current.frozenAt).toBeNull();

    await service.submit(authorId, created.id, { approverId });

    const frozen = await prisma.workLogVersion.findUniqueOrThrow({ where: { id: current.id } });
    expect(frozen.frozenAt).not.toBeNull();
    await expect(
      prisma.$executeRaw`UPDATE "work_log_versions" SET "completion" = '篡改' WHERE "id" = ${current.id}`,
    ).rejects.toThrow(/frozen/);
    const after = await prisma.workLogVersion.findUniqueOrThrow({ where: { id: current.id } });
    expect(after.completion).toBe(draft.completion);
  });

  it('freezes the current version at the database level when the log leaves DRAFT', async () => {
    // 模拟"应用漏写 frozen_at"：绕过 service，直接用 SQL 改状态。
    // 数据库必须在状态离开 DRAFT 时自己冻结当前版本，否则历史会 fail-open。
    const authorId = await createUser('author');
    const projectId = await createProject();
    await addMember(authorId, projectId, ['MEMBER']);
    const created = await service.createDraft(authorId, { ...draft, projectId });
    const current = await prisma.workLogVersion.findFirstOrThrow({
      where: { workLogId: created.id },
    });
    expect(current.frozenAt).toBeNull();

    await prisma.$executeRaw`UPDATE "work_logs" SET "status" = 'SUBMITTED' WHERE "id" = ${created.id}`;

    const frozen = await prisma.workLogVersion.findUniqueOrThrow({ where: { id: current.id } });
    expect(frozen.frozenAt).not.toBeNull();
    await expect(
      prisma.$executeRaw`UPDATE "work_log_versions" SET "completion" = '篡改' WHERE "id" = ${current.id}`,
    ).rejects.toThrow(/frozen/);
    const after = await prisma.workLogVersion.findUniqueOrThrow({ where: { id: current.id } });
    expect(after.completion).toBe(draft.completion);
  });

  it('rejects repointing the current version of a submitted log', async () => {
    const authorId = await createUser('author');
    const approverId = await createUser('approver');
    const projectId = await createProject();
    await addMember(authorId, projectId, ['MEMBER']);
    await addMember(approverId, projectId, ['APPROVER']);
    const created = await service.createDraft(authorId, { ...draft, projectId });
    const current = await prisma.workLogVersion.findFirstOrThrow({
      where: { workLogId: created.id },
    });
    await service.submit(authorId, created.id, { approverId });

    // 必须是"不同的值"才会进入重指向分支；这里清空指针同样属于非法重指向。
    await expect(
      prisma.$executeRaw`UPDATE "work_logs" SET "current_version_id" = NULL WHERE "id" = ${created.id}`,
    ).rejects.toThrow(/current version can only change while the work log is a draft/);
    // 伪造版本 + 重指向的组合也必须被挡（版本 INSERT 守卫）。
    await expect(
      prisma.$executeRaw`
        INSERT INTO "work_log_versions" ("id","work_log_id","version_number","work_date","hours","completion","submitted_by_id","submitted_at","created_at")
        VALUES ('v-forged-2', ${created.id}, 7, '2026-11-06', 1, 'FORGED', ${authorId}, now(), now())
      `,
    ).rejects.toThrow(/may only be appended while the work log is a draft/);
    expect(current.id).toBeTruthy();
  });

  it('rejects appending a version to a submitted log', async () => {
    const authorId = await createUser('author');
    const approverId = await createUser('approver');
    const projectId = await createProject();
    await addMember(authorId, projectId, ['MEMBER']);
    await addMember(approverId, projectId, ['APPROVER']);
    const created = await service.createDraft(authorId, { ...draft, projectId });
    await service.submit(authorId, created.id, { approverId });

    await expect(
      prisma.$executeRaw`
        INSERT INTO "work_log_versions" ("id","work_log_id","version_number","work_date","hours","completion","submitted_by_id","submitted_at","created_at")
        VALUES ('v-forged', ${created.id}, 9, '2026-11-06', 1, 'FORGED CONTENT', ${authorId}, now(), now())
      `,
    ).rejects.toThrow(/may only be appended while the work log is a draft/);
    expect(await prisma.workLogVersion.count({ where: { workLogId: created.id } })).toBe(1);
  });

  it('freezes every unfrozen version when the log leaves DRAFT in one statement', async () => {
    const authorId = await createUser('author');
    const projectId = await createProject();
    await addMember(authorId, projectId, ['MEMBER']);
    const created = await service.createDraft(authorId, { ...draft, projectId });
    // 追加第二个版本（DRAFT 允许），但不把它设为当前版本。
    await prisma.$executeRaw`
      INSERT INTO "work_log_versions" ("id","work_log_id","version_number","work_date","hours","completion","submitted_by_id","submitted_at","created_at")
      VALUES ('v-extra', ${created.id}, 2, '2026-11-06', 1, 'extra draft', ${authorId}, now(), now())
    `;
    const first = await prisma.workLogVersion.findFirstOrThrow({
      where: { workLogId: created.id, versionNumber: 1 },
    });

    // 离开 DRAFT（不重指向）：该日志下所有未冻结版本都必须被冻结，
    // 包括不是当前版本的那一条。
    await prisma.$executeRaw`
      UPDATE "work_logs" SET "status" = 'SUBMITTED' WHERE "id" = ${created.id}
    `;
    // 同时重指向属于非法操作，必须被拒（M2）。
    await expect(
      prisma.$executeRaw`
        UPDATE "work_logs" SET "current_version_id" = 'v-extra' WHERE "id" = ${created.id}
      `,
    ).rejects.toThrow(/current version can only change while the work log is a draft/);

    const after = await prisma.workLogVersion.findMany({ where: { workLogId: created.id } });
    expect(after.every((v) => v.frozenAt !== null)).toBe(true);
    await expect(
      prisma.$executeRaw`UPDATE "work_log_versions" SET "completion" = '篡改' WHERE "id" = ${first.id}`,
    ).rejects.toThrow(/frozen/);
  });

  it('rejects inserting a work log that does not start in DRAFT', async () => {
    const authorId = await createUser('author');
    const projectId = await createProject();
    await expect(
      prisma.$executeRaw`
        INSERT INTO "work_logs" ("id","number","author_id","project_id","status","visibility","version","created_at","updated_at")
        VALUES ('wl-forged','WL-FORGED',${authorId},${projectId},'APPROVED','PRIVATE',1,now(),now())
      `,
    ).rejects.toThrow(/must start in DRAFT/);
  });
});

describe('WorkLogsService visibility (real PostgreSQL)', () => {
  async function seedProjectWithLog() {
    const authorId = await createUser('author');
    const managerId = await createUser('manager');
    const memberId = await createUser('member');
    const projectId = await createProject();
    await addMember(authorId, projectId, ['MEMBER']);
    await addMember(managerId, projectId, ['PROJECT_MANAGER']);
    await addMember(memberId, projectId, ['MEMBER']);
    const created = await service.createDraft(authorId, { ...draft, projectId });
    return { authorId, managerId, memberId, projectId, workLogId: created.id };
  }

  it('lets a project manager flip visibility with the optimistic token', async () => {
    const { managerId, workLogId } = await seedProjectWithLog();

    await service.setVisibility(managerId, workLogId, {
      visibility: 'PROJECT_VISIBLE',
      version: 1,
    });

    const log = await prisma.workLog.findUniqueOrThrow({ where: { id: workLogId } });
    expect(log.visibility).toBe('PROJECT_VISIBLE');
    expect(log.version).toBe(2);
  });

  it('rejects a plain member and keeps the stored visibility unchanged', async () => {
    const { memberId, workLogId } = await seedProjectWithLog();

    await expect(
      service.setVisibility(memberId, workLogId, { visibility: 'PROJECT_VISIBLE', version: 1 }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    const log = await prisma.workLog.findUniqueOrThrow({ where: { id: workLogId } });
    expect(log.visibility).toBe('PRIVATE');
  });

  it('returns metadata only (no content, no attachments) for the manager', async () => {
    const { managerId, projectId, workLogId } = await seedProjectWithLog();

    const page = await service.listVisibilityMetadata(managerId, projectId, {
      page: 1,
      pageSize: 10,
    });

    expect(page.total).toBe(1);
    expect(page.items).toEqual([{ id: workLogId, visibility: 'PRIVATE', version: 1 }]);
    // 元数据里不得出现正文/历史/附件字段。
    expect(Object.keys(page.items[0]!)).toEqual(['id', 'visibility', 'version']);
  });

  it('rejects a capability holder who is not a member of that project', async () => {
    const { workLogId, projectId } = await seedProjectWithLog();
    const outsiderId = await createUser('outsider-capability');
    // 授予全局 worklog:manage：仍必须受项目成员身份约束（用户 2026-11-07 决定）。
    // 角色 key 随机化 + finally 清理：该用例必须能在同一个库上重复运行。
    const roleKey = `WORKLOG_MANAGER_PROBE_${randomUUID().slice(0, 8)}`;
    const role = await prisma.systemRole.create({
      data: { key: roleKey, name: '临时角色' },
    });
    try {
      const permission = await prisma.permission.upsert({
        where: { key: 'worklog:manage' },
        update: {},
        create: { key: 'worklog:manage', description: '管理工作日志（项目内）' },
      });
      await prisma.rolePermission.create({
        data: { systemRoleId: role.id, permissionId: permission.id },
      });
      await prisma.userSystemRole.create({
        data: { userId: outsiderId, systemRoleId: role.id },
      });

      await expect(
        service.setVisibility(outsiderId, workLogId, {
          visibility: 'PROJECT_VISIBLE',
          version: 1,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        service.listVisibilityMetadata(outsiderId, projectId, { page: 1, pageSize: 10 }),
      ).rejects.toBeInstanceOf(NotFoundException);
    } finally {
      await prisma.userSystemRole.deleteMany({ where: { systemRoleId: role.id } });
      await prisma.rolePermission.deleteMany({ where: { systemRoleId: role.id } });
      await prisma.systemRole.delete({ where: { id: role.id } }).catch(() => undefined);
    }
    const log = await prisma.workLog.findUniqueOrThrow({ where: { id: workLogId } });
    expect(log.visibility).toBe('PRIVATE');
  });

  it('rejects a suspended account even with the project manager role', async () => {
    const { managerId, workLogId, projectId } = await seedProjectWithLog();
    await prisma.user.update({ where: { id: managerId }, data: { status: 'SUSPENDED' } });

    // 权限内核必须把停用账号当作"没有项目作用域"（404，而不是 403）。
    await expect(
      service.setVisibility(managerId, workLogId, {
        visibility: 'PROJECT_VISIBLE',
        version: 1,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.listVisibilityMetadata(managerId, projectId, { page: 1, pageSize: 10 }),
    ).rejects.toBeInstanceOf(NotFoundException);
    const log = await prisma.workLog.findUniqueOrThrow({ where: { id: workLogId } });
    expect(log.visibility).toBe('PRIVATE');
  });

  it('rejects a stale version on visibility change and keeps the stored value', async () => {
    const { managerId, workLogId } = await seedProjectWithLog();
    await service.setVisibility(managerId, workLogId, {
      visibility: 'PROJECT_VISIBLE',
      version: 1,
    });

    await expect(
      service.setVisibility(managerId, workLogId, { visibility: 'PRIVATE', version: 1 }),
    ).rejects.toBeInstanceOf(ConflictException);
    const log = await prisma.workLog.findUniqueOrThrow({ where: { id: workLogId } });
    expect(log.visibility).toBe('PROJECT_VISIBLE');
    expect(log.version).toBe(2);
  });

  it('lets a member holding worklog:manage change another author log', async () => {
    const { projectId, workLogId } = await seedProjectWithLog();
    const managerCapabilityId = await createUser('capability-holder');
    await addMember(managerCapabilityId, projectId, ['MEMBER']);
    const permission = await prisma.permission.upsert({
      where: { key: 'worklog:manage' },
      update: {},
      create: { key: 'worklog:manage', description: '管理工作日志（项目内）' },
    });
    const roleKey = `WORKLOG_CAP_${randomUUID().slice(0, 8)}`;
    const role = await prisma.systemRole.create({ data: { key: roleKey, name: '临时角色' } });
    try {
      await prisma.rolePermission.create({
        data: { systemRoleId: role.id, permissionId: permission.id },
      });
      await prisma.userSystemRole.create({
        data: { userId: managerCapabilityId, systemRoleId: role.id },
      });

      const result = await service.setVisibility(managerCapabilityId, workLogId, {
        visibility: 'PROJECT_VISIBLE',
        version: 1,
      });
      expect(result).toEqual({ id: workLogId, visibility: 'PROJECT_VISIBLE', version: 2 });
    } finally {
      await prisma.userSystemRole.deleteMany({ where: { systemRoleId: role.id } });
      await prisma.rolePermission.deleteMany({ where: { systemRoleId: role.id } });
      await prisma.systemRole.delete({ where: { id: role.id } }).catch(() => undefined);
    }
  });

  it('denies the metadata endpoint to a plain member', async () => {
    const { memberId, projectId } = await seedProjectWithLog();

    await expect(
      service.listVisibilityMetadata(memberId, projectId, { page: 1, pageSize: 10 }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('work log project events (real PostgreSQL)', () => {
  it('records lifecycle events without leaking completion text', async () => {
    const authorId = await createUser('author');
    const approverId = await createUser('approver');
    const projectId = await createProject();
    await addMember(authorId, projectId, ['MEMBER']);
    await addMember(approverId, projectId, ['APPROVER']);
    const created = await service.createDraft(authorId, { ...draft, projectId });
    await service.submit(authorId, created.id, { approverId });

    const events = await prisma.projectEvent.findMany({
      where: { projectId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    expect(events.map((e) => e.eventType)).toEqual(['WORK_LOG_CREATED', 'WORK_LOG_SUBMITTED']);
    for (const event of events) {
      expect(event.actorId).toBe(authorId);
      // 摘要不得包含正文/工时等私有内容。
      expect(event.summary).not.toContain(draft.completion);
      expect(event.summary).not.toContain(String(draft.hours));
    }
  });

  it('writes the creation event and the log atomically', async () => {
    const authorId = await createUser('author');
    const projectId = await createProject();
    await addMember(authorId, projectId, ['MEMBER']);

    // 让事件写入失败：日志必须一起回滚，不能留下"有日志无事件"的半成品。
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "project_events" ADD CONSTRAINT "project_events_probe_check" CHECK ("event_type" <> \'WORK_LOG_CREATED\')',
    );
    try {
      await expect(service.createDraft(authorId, { ...draft, projectId })).rejects.toBeTruthy();
      expect(await prisma.workLog.count({ where: { projectId } })).toBe(0);
      expect(await prisma.projectEvent.count({ where: { projectId } })).toBe(0);
    } finally {
      await prisma.$executeRawUnsafe(
        'ALTER TABLE "project_events" DROP CONSTRAINT IF EXISTS "project_events_probe_check"',
      );
    }
  });

  it('writes no event when the submission is rejected', async () => {
    const authorId = await createUser('author');
    const approverId = await createUser('approver');
    const projectId = await createProject();
    await addMember(authorId, projectId, ['MEMBER']);
    await addMember(approverId, projectId, ['APPROVER']);
    const created = await service.createDraft(authorId, { ...draft, projectId });
    await service.submit(authorId, created.id, { approverId });
    const before = await prisma.projectEvent.count({ where: { projectId } });

    await expect(service.submit(authorId, created.id, { approverId })).rejects.toBeInstanceOf(
      ConflictException,
    );

    expect(await prisma.projectEvent.count({ where: { projectId } })).toBe(before);
  });

  it('rolls back the submission when the event cannot be written', async () => {
    const authorId = await createUser('author');
    const approverId = await createUser('approver');
    const projectId = await createProject();
    await addMember(authorId, projectId, ['MEMBER']);
    await addMember(approverId, projectId, ['APPROVER']);
    const created = await service.createDraft(authorId, { ...draft, projectId });

    await prisma.$executeRawUnsafe(
      'ALTER TABLE "project_events" ADD CONSTRAINT "project_events_probe_submitted" CHECK ("event_type" <> \'WORK_LOG_SUBMITTED\')',
    );
    try {
      await expect(service.submit(authorId, created.id, { approverId })).rejects.toBeTruthy();
      const log = await prisma.workLog.findUniqueOrThrow({ where: { id: created.id } });
      expect(log.status).toBe('DRAFT');
      expect(await prisma.approvalRequest.count()).toBe(0);
      const events = await prisma.projectEvent.findMany({ where: { projectId } });
      expect(events.map((e) => e.eventType)).toEqual(['WORK_LOG_CREATED']);
    } finally {
      await prisma.$executeRawUnsafe(
        'ALTER TABLE "project_events" DROP CONSTRAINT IF EXISTS "project_events_probe_submitted"',
      );
    }
  });
});

describe('WorkLogsService.listMine (real PostgreSQL)', () => {
  it('returns only the caller logs with paging totals', async () => {
    const authorId = await createUser('author');
    const otherId = await createUser('other');
    const projectId = await createProject();
    await addMember(authorId, projectId, ['MEMBER']);
    await addMember(otherId, projectId, ['MEMBER']);
    await service.createDraft(authorId, { ...draft, projectId });
    await service.createDraft(authorId, { ...draft, projectId });
    await service.createDraft(otherId, { ...draft, projectId });

    const page = await service.listMine(authorId, { page: 1, pageSize: 10 });

    expect(page.total).toBe(2);
    expect(page.items).toHaveLength(2);
    expect(Object.keys(page.items[0]!).sort()).toEqual(
      ['currentVersion', 'id', 'number', 'project', 'status', 'version', 'visibility'].sort(),
    );
  });
});

describe('approver eligibility (real PostgreSQL)', () => {
  it('rejects an approver who is a plain member without the approver role', async () => {
    const authorId = await createUser('author');
    const plainId = await createUser('plain');
    const projectId = await createProject();
    await addMember(authorId, projectId, ['MEMBER']);
    await addMember(plainId, projectId, ['MEMBER']);
    const created = await service.createDraft(authorId, { ...draft, projectId });

    await expect(
      service.submit(authorId, created.id, { approverId: plainId }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(await prisma.approvalRequest.count()).toBe(0);
    const log = await prisma.workLog.findUniqueOrThrow({ where: { id: created.id } });
    expect(log.status).toBe('DRAFT');
  });

  it('accepts an approver holding approval:decide without the project approver role', async () => {
    const authorId = await createUser('author');
    const capabilityId = await createUser('capability-approver');
    const projectId = await createProject();
    await addMember(authorId, projectId, ['MEMBER']);
    await addMember(capabilityId, projectId, ['MEMBER']);
    const created = await service.createDraft(authorId, { ...draft, projectId });

    const permission = await prisma.permission.upsert({
      where: { key: 'approval:decide' },
      update: {},
      create: { key: 'approval:decide', description: '审批决策' },
    });
    const roleKey = `APPROVAL_CAP_${randomUUID().slice(0, 8)}`;
    const role = await prisma.systemRole.create({ data: { key: roleKey, name: '临时审批能力' } });
    try {
      await prisma.rolePermission.create({
        data: { systemRoleId: role.id, permissionId: permission.id },
      });
      await prisma.userSystemRole.create({
        data: { userId: capabilityId, systemRoleId: role.id },
      });

      const result = await service.submit(authorId, created.id, { approverId: capabilityId });
      expect(result.status).toBe('SUBMITTED');
    } finally {
      await prisma.userSystemRole.deleteMany({ where: { systemRoleId: role.id } });
      await prisma.rolePermission.deleteMany({ where: { systemRoleId: role.id } });
      await prisma.systemRole.delete({ where: { id: role.id } }).catch(() => undefined);
    }
  });
});
