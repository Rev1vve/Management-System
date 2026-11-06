import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PrismaService } from '../../src/database/prisma.service';
import { installWindowsAclAllowlist } from '../../src/testing/windows-acl-allowlist';
import { AttachmentsService } from '../../src/modules/attachments/attachments.service';
import { WorkLogAttachmentsService } from '../../src/modules/attachments/work-log-attachments.service';
import { CustomersService } from '../../src/modules/customers/customers.service';
import { ProjectAccessService } from '../../src/modules/project-access/project-access.service';
import { RolesService } from '../../src/modules/roles/roles.service';
import { WorkLogsService } from '../../src/modules/work-logs/work-logs.service';

/**
 * 任务 8 附件（D-D）真库 + 真文件系统验收：
 * 上传 → 提交时绑定冻结版本 → 退回后的新版本不继承 → 下载/归档的授权边界。
 */
const prisma = new PrismaService();

const TABLES = [
  'attachments',
  'approval_decisions',
  'approval_requests',
  'work_log_versions',
  'work_logs',
  'order_items',
  'orders',
  'project_membership_roles',
  'project_memberships',
  'projects',
  'users',
];

let attachmentsRoot = '';
let attachments: AttachmentsService;
let workLogAttachments: WorkLogAttachmentsService;
let workLogs: WorkLogsService;

const pdf = Buffer.from('%PDF-1.7\nwork log attachment content', 'utf8');

async function truncateAll(): Promise<void> {
  const joined = TABLES.map((t) => `"${t}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${joined} RESTART IDENTITY CASCADE`);
}

beforeAll(async () => {
  await installWindowsAclAllowlist();
  attachmentsRoot = await mkdtemp(join(tmpdir(), 'poc-work-log-attachments-'));
  process.env.ATTACHMENTS_ROOT = attachmentsRoot;
  const projectAccess = new ProjectAccessService(prisma);
  const roles = new RolesService(prisma);
  attachments = new AttachmentsService(
    prisma,
    new CustomersService(prisma, projectAccess, roles),
    attachmentsRoot,
  );
  workLogAttachments = new WorkLogAttachmentsService(prisma, attachments);
  workLogs = new WorkLogsService(prisma, projectAccess, roles);
});

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
  if (attachmentsRoot) await rm(attachmentsRoot, { recursive: true, force: true });
});

async function createUser(account: string): Promise<string> {
  const user = await prisma.user.create({
    data: { account, name: account, workEmail: `${account}@example.test`, status: 'ACTIVE' },
  });
  return user.id;
}

async function seedDraft() {
  const authorId = await createUser('author');
  const approverId = await createUser('approver');
  const projectId = await prisma.project
    .create({ data: { number: 'PRJ-0001', name: '项目', status: 'ACTIVE' } })
    .then((p) => p.id);
  const membership = await prisma.projectMembership.create({
    data: { userId: authorId, projectId },
  });
  await prisma.projectMembershipRole.create({
    data: { membershipId: membership.id, role: 'MEMBER' },
  });
  const approverMembership = await prisma.projectMembership.create({
    data: { userId: approverId, projectId },
  });
  await prisma.projectMembershipRole.create({
    data: { membershipId: approverMembership.id, role: 'APPROVER' },
  });
  const created = await workLogs.createDraft(authorId, {
    projectId,
    workDate: '2026-11-06',
    hours: 4,
    completion: '草稿内容',
  });
  return { authorId, approverId, projectId, workLogId: created.id };
}

const upload = (name = 'evidence.pdf') => ({
  originalname: name,
  mimetype: 'application/pdf',
  size: pdf.length,
  buffer: pdf,
});

describe('WorkLogAttachmentsService (real PostgreSQL + real filesystem)', () => {
  it('stores a draft attachment under the work-log prefix and lists it', async () => {
    const { authorId, workLogId } = await seedDraft();

    const stored = await workLogAttachments.upload(authorId, workLogId, upload());
    expect(stored.originalName).toBe('evidence.pdf');

    const row = await prisma.attachment.findUniqueOrThrow({ where: { id: stored.id } });
    expect(row.storageKey).toMatch(/^work-log\/[0-9a-f]{2}\/[0-9a-f-]{36}\.pdf$/);
    expect(row.resourceType).toBe('WORK_LOG');
    expect(row.workLogId).toBe(workLogId);

    const listed = await workLogAttachments.list(authorId, workLogId);
    expect(listed.map((a) => a.id)).toEqual([stored.id]);
  });

  it('binds draft attachments to the frozen version on submit and does not inherit them on return', async () => {
    const { authorId, approverId, workLogId } = await seedDraft();
    const stored = await workLogAttachments.upload(authorId, workLogId, upload());

    await workLogs.submit(authorId, workLogId, { approverId });

    const log = await prisma.workLog.findUniqueOrThrow({ where: { id: workLogId } });
    const bound = await prisma.attachment.findUniqueOrThrow({ where: { id: stored.id } });
    expect(bound.resourceType).toBe('WORK_LOG_VERSION');
    expect(bound.resourceId).toBe(log.currentVersionId);

    // 退回后开新版本：新版本没有任何附件（D-D：不继承旧附件）。
    await prisma.workLog.update({ where: { id: workLogId }, data: { status: 'RETURNED' } });
    const added = await workLogs.addVersion(authorId, workLogId, {
      workDate: '2026-11-07',
      hours: 2,
      completion: '按退回意见修改',
    });
    const after = await prisma.workLog.findUniqueOrThrow({ where: { id: workLogId } });
    expect(after.currentVersionId).not.toBe(log.currentVersionId);
    expect(added.versionNumber).toBe(2);
    const stillBound = await prisma.attachment.findUniqueOrThrow({ where: { id: stored.id } });
    expect(stillBound.resourceId).toBe(log.currentVersionId);

    // D-D 的接口面语义：新草稿不再展示/下载旧版本的冻结附件，也不能归档它。
    expect(await workLogAttachments.list(authorId, workLogId)).toHaveLength(0);
    await expect(
      workLogAttachments.download(authorId, workLogId, stored.id),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(workLogAttachments.archive(authorId, workLogId, stored.id)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('serves the stored bytes to the author and hides them from everyone else', async () => {
    const { authorId, workLogId } = await seedDraft();
    const outsiderId = await createUser('outsider');
    const stored = await workLogAttachments.upload(authorId, workLogId, upload());

    const download = await workLogAttachments.download(authorId, workLogId, stored.id);
    const chunks: Buffer[] = [];
    for await (const chunk of download.stream as AsyncIterable<Buffer>) chunks.push(chunk);
    expect(Buffer.concat(chunks).equals(pdf)).toBe(true);

    await expect(
      workLogAttachments.download(outsiderId, workLogId, stored.id),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses uploads after submit and refuses archiving a frozen attachment', async () => {
    const { authorId, approverId, workLogId } = await seedDraft();
    const stored = await workLogAttachments.upload(authorId, workLogId, upload());
    await workLogs.submit(authorId, workLogId, { approverId });

    await expect(workLogAttachments.upload(authorId, workLogId, upload())).rejects.toBeInstanceOf(
      ConflictException,
    );
    // 已冻结到版本的附件不能再被草稿接口删除。
    await expect(workLogAttachments.archive(authorId, workLogId, stored.id)).rejects.toBeTruthy();
  });
});
