import { randomUUID } from 'node:crypto';

import { ConflictException, NotFoundException } from '@nestjs/common';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

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

afterEach(async () => {
  // 不把 PENDING 行/文件留给后续 spec 的启动 reconciliation（跨文件共享同一个库）。
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
      NotFoundException,
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
    // 日志已离开 DRAFT：草稿接口一律 409（与 upload 同口径）。
    await expect(workLogAttachments.archive(authorId, workLogId, stored.id)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});

describe('WORK_LOG pending recovery', () => {
  // 构造一条真实的 WORK_LOG PENDING 行（含已发布文件与 dev/ino 身份），
  // 再跑启动 reconciliation，固定"作者仍 DRAFT 才激活、否则保留证据"的行为。
  async function seedPending(logStatus: 'DRAFT' | 'SUBMITTED', authorStatus: 'ACTIVE' | 'INVITED') {
    const authorId = await createUser(`author-${logStatus}-${authorStatus}`);
    const projectId = await prisma.project
      .create({
        data: { number: `PRJ-${logStatus}-${authorStatus}`, name: '项目', status: 'ACTIVE' },
      })
      .then((p) => p.id);
    const membership = await prisma.projectMembership.create({
      data: { userId: authorId, projectId },
    });
    await prisma.projectMembershipRole.create({
      data: { membershipId: membership.id, role: 'MEMBER' },
    });
    const created = await workLogs.createDraft(authorId, {
      projectId,
      workDate: '2026-11-06',
      hours: 1,
      completion: '草稿',
    });
    if (logStatus !== 'DRAFT') {
      await prisma.$executeRaw`UPDATE "work_logs" SET "status" = ${logStatus} WHERE "id" = ${created.id}`;
    }
    if (authorStatus !== 'ACTIVE') {
      await prisma.user.update({ where: { id: authorId }, data: { status: authorStatus } });
    }

    // 用真实存储管道写出一个"已发布但未激活"的待恢复行。
    const id = randomUUID();
    const storageKey = `work-log/${id.slice(0, 2)}/${id}.pdf`;
    const pendingId = await attachments.storeAttachmentFile({
      userId: authorId,
      file: upload(),
      validated: { originalName: 'evidence.pdf', extension: '.pdf', mime: 'application/pdf' },
      storageKey,
      createData: {
        resourceType: 'WORK_LOG',
        resourceId: created.id,
        workLog: { connect: { id: created.id } },
      },
      onRelationLost: async () => {
        throw new Error('relation lost');
      },
    });
    // 预置失败痕迹，才能证明"恢复成功会清掉 attempts/lastError"（否则断言恒真）。
    await prisma.attachment.update({
      where: { id: pendingId },
      data: { storageCleanupAttempts: 2, storageCleanupLastError: 'PENDING_AUTHORIZATION_MISSING' },
    });
    return { authorId, workLogId: created.id, pendingId };
  }

  it('activates a pending work-log attachment while the author log is still DRAFT', async () => {
    const { pendingId } = await seedPending('DRAFT', 'ACTIVE');

    await attachments.onApplicationBootstrap();

    const row = await prisma.attachment.findUniqueOrThrow({ where: { id: pendingId } });
    expect(row.status).toBe('ACTIVE');
    expect(row.storageCleanupAttempts).toBe(0);
    expect(row.storageCleanupLastError).toBeNull();
  });

  it('keeps the pending row and file when the log already left DRAFT', async () => {
    const { pendingId } = await seedPending('SUBMITTED', 'ACTIVE');

    await attachments.onApplicationBootstrap();

    const row = await prisma.attachment.findUniqueOrThrow({ where: { id: pendingId } });
    expect(row.status).toBe('PENDING');
    expect(row.storageCleanupAttempts).toBeGreaterThan(0);
    expect(row.storageCleanupLastError).toBe('PENDING_AUTHORIZATION_MISSING');
    // 证据必须保留：PENDING 行对应的文件仍然存在（身份校验可打开它）。
    const { stream } = await attachments.openVerifiedAttachmentStream(row);
    expect(stream).toBeTruthy();
    (stream as unknown as { destroy: () => void }).destroy();
  });

  it('keeps the pending row when the author account is no longer active', async () => {
    const { pendingId } = await seedPending('DRAFT', 'INVITED');

    await attachments.onApplicationBootstrap();

    const row = await prisma.attachment.findUniqueOrThrow({ where: { id: pendingId } });
    expect(row.status).toBe('PENDING');
    expect(row.storageCleanupLastError).toBe('PENDING_AUTHORIZATION_MISSING');
  });

  it('archives an unbound draft attachment successfully', async () => {
    const { authorId, workLogId } = await seedDraft();
    const stored = await workLogAttachments.upload(authorId, workLogId, upload());

    await expect(workLogAttachments.archive(authorId, workLogId, stored.id)).resolves.toEqual({
      ok: true,
    });
    expect(await workLogAttachments.list(authorId, workLogId)).toHaveLength(0);
  });
});
