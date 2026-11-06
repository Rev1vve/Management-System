import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { WorkLogsService } from './work-logs.service';

/**
 * Task 8 第二片：提交冻结。
 *
 * 约束（主计划 §4.2 D-E）：
 *  - 只有作者本人可提交；他人一律 404（不泄露存在性）。
 *  - 仅 DRAFT 可直接提交；SUBMITTED/APPROVED/RETURNED/REJECTED 均 409（RETURNED 必须走新草稿版本）。
 *  - 提交在同一事务内：CAS 改状态为 SUBMITTED + 生成 PENDING 审批请求，Submitter≠Approver。
 *  - 审批人必须是该项目当前有效成员。
 *  - 缺少 currentVersionId 时 fail closed（409），不允许提交没有冻结版本的日志。
 */
function createPrismaMock(log: Record<string, unknown> | null = null) {
  const tx = {
    workLog: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    approvalRequest: { create: vi.fn().mockResolvedValue({ id: 'approval-1' }) },
    projectMembership: { findFirst: vi.fn().mockResolvedValue({ id: 'membership-1' }) },
    workLogVersion: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
  };
  const prisma = {
    workLog: { findFirst: vi.fn().mockResolvedValue(log) },
    projectMembership: { findFirst: vi.fn().mockResolvedValue({ id: 'membership-1' }) },
    $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
    tx,
  };
  return prisma;
}

function createService(prisma: ReturnType<typeof createPrismaMock>) {
  const projectAccess = { assertProjectAccess: vi.fn() };
  const roles = { listUserPermissions: vi.fn().mockResolvedValue([]) };
  return new WorkLogsService(prisma as never, projectAccess as never, roles as never);
}

const draftLog = {
  id: 'wl-1',
  status: 'DRAFT',
  projectId: 'project-1',
  currentVersionId: 'wlv-1',
  authorId: 'author-1',
};

describe('WorkLogsService submit', () => {
  let prisma: ReturnType<typeof createPrismaMock>;

  beforeEach(() => {
    prisma = createPrismaMock({ ...draftLog });
  });

  it('freezes the current version, flips to SUBMITTED and creates a PENDING approval request', async () => {
    const service = createService(prisma);

    const result = await service.submit('author-1', 'wl-1', { approverId: 'approver-1' });

    expect(result).toEqual({ id: 'wl-1', status: 'SUBMITTED', approvalRequestId: 'approval-1' });
    expect(prisma.tx.workLog.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'wl-1',
          authorId: 'author-1',
          status: 'DRAFT',
          currentVersionId: 'wlv-1',
          deletedAt: null,
        }),
        data: expect.objectContaining({ status: 'SUBMITTED' }),
      }),
    );
    expect(prisma.tx.approvalRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          workLogVersionId: 'wlv-1',
          approverId: 'approver-1',
          submitterId: 'author-1',
          status: 'PENDING',
        }),
      }),
    );
  });

  it('freezes the current version in the same transaction as the submission', async () => {
    const service = createService(prisma);

    await service.submit('author-1', 'wl-1', { approverId: 'approver-1' });

    expect(prisma.tx.workLogVersion.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'wlv-1', workLogId: 'wl-1', frozenAt: null },
        data: { frozenAt: expect.any(Date) },
      }),
    );
  });

  it('rejects a non-author with 404 and writes nothing', async () => {
    prisma = createPrismaMock(null);
    const service = createService(prisma);

    await expect(
      service.submit('someone-else', 'wl-1', { approverId: 'approver-1' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each(['SUBMITTED', 'APPROVED', 'RETURNED', 'REJECTED'])(
    'rejects submission from %s status with 409',
    async (status) => {
      prisma = createPrismaMock({ ...draftLog, status });
      const service = createService(prisma);

      await expect(
        service.submit('author-1', 'wl-1', { approverId: 'approver-1' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    },
  );

  it('rejects self-approval', async () => {
    const service = createService(prisma);

    await expect(
      service.submit('author-1', 'wl-1', { approverId: 'author-1' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('returns 404 when the author is no longer an active project member', async () => {
    prisma = createPrismaMock({ ...draftLog });
    // 第一次查询是审批人资格（通过），第二次是作者资格（返回 null）。
    prisma.tx.projectMembership.findFirst
      .mockResolvedValueOnce({ id: 'membership-approver' })
      .mockResolvedValueOnce(null);
    const service = createService(prisma);

    await expect(
      service.submit('author-1', 'wl-1', { approverId: 'approver-1' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.tx.workLog.updateMany).not.toHaveBeenCalled();
    expect(prisma.tx.approvalRequest.create).not.toHaveBeenCalled();
  });

  it('fails closed when the log has no frozen current version', async () => {
    prisma = createPrismaMock({ ...draftLog, currentVersionId: null });
    const service = createService(prisma);

    await expect(
      service.submit('author-1', 'wl-1', { approverId: 'approver-1' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('returns 409 when the compare-and-set loses a concurrent race', async () => {
    prisma = createPrismaMock({ ...draftLog });
    prisma.tx.workLog.updateMany.mockResolvedValue({ count: 0 });
    const service = createService(prisma);

    await expect(
      service.submit('author-1', 'wl-1', { approverId: 'approver-1' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.tx.approvalRequest.create).not.toHaveBeenCalled();
  });
});
