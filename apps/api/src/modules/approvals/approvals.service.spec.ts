import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PERMISSIONS } from '../authorization/permission.constants';
import { ApprovalsService } from './approvals.service';

/**
 * 任务 9 单级审批的判定规则：
 *  - 只有被指定的审批人可以决策（其他人一律 404，不泄露存在性）；
 *  - 禁止自审、重复审批、并发审批（PENDING + SUBMITTED + 版本一致性三重校验）；
 *  - 决策必须与"当前版本"严格一致（currentVersionId === approval.workLogVersionId），
 *    防止历史遗留的重指向让旧版本的审批覆盖新版本。
 */
function createPrismaMock(overrides: Record<string, unknown> = {}) {
  const request = {
    id: 'approval-1',
    approverId: 'approver-1',
    submitterId: 'author-1',
    workLogVersionId: 'wlv-1',
    status: 'PENDING',
    workLogVersion: {
      id: 'wlv-1',
      versionNumber: 1,
      workLogId: 'wl-1',
      workLog: {
        id: 'wl-1',
        number: 'WL-1',
        projectId: 'project-1',
        authorId: 'author-1',
        status: 'SUBMITTED',
        currentVersionId: 'wlv-1',
        version: 3,
      },
    },
    ...overrides,
  };
  const tx = {
    approvalRequest: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    approvalDecision: { create: vi.fn().mockResolvedValue({ id: 'decision-1' }) },
    workLog: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findFirst: vi.fn().mockResolvedValue({ id: 'wl-1' }),
    },
    projectEvent: { create: vi.fn().mockResolvedValue({ id: 'event-1' }) },
    notification: { create: vi.fn().mockResolvedValue({ id: 'notification-1' }) },
    emailOutbox: { create: vi.fn().mockResolvedValue({ id: 'email-1' }) },

    projectMembership: {
      findFirst: vi.fn().mockResolvedValue({ id: 'membership-1', roles: [{ role: 'APPROVER' }] }),
    },
    user: { findUnique: vi.fn().mockResolvedValue({ workEmail: 'author@example.com' }) },
  };
  const prisma = {
    approvalRequest: {
      findUnique: vi.fn().mockResolvedValue(request),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
    projectMembership: {
      findMany: vi
        .fn()
        .mockResolvedValue([{ projectId: 'project-1', roles: [{ role: 'APPROVER' }] }]),
    },

    $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
    tx,
    rawRequest: request,
  };
  return prisma;
}

function createService(
  prisma: ReturnType<typeof createPrismaMock>,
  options?: { roles?: string[]; permissions?: string[]; accessDenied?: boolean },
) {
  const projectAccess = {
    assertProjectAccess: options?.accessDenied
      ? vi.fn().mockRejectedValue(new NotFoundException('项目不存在'))
      : vi.fn().mockResolvedValue({ roles: options?.roles ?? ['APPROVER'] }),
  };
  const roles = {
    listUserPermissions: vi.fn().mockResolvedValue(options?.permissions ?? []),
  };
  return new ApprovalsService(prisma as never, projectAccess as never, roles as never);
}

describe('ApprovalsService.decide', () => {
  let prisma: ReturnType<typeof createPrismaMock>;

  beforeEach(() => {
    prisma = createPrismaMock();
  });

  it('records the decision, the log transition, the event, the notification and the outbox row', async () => {
    const service = createService(prisma);

    await service.decide('approver-1', 'approval-1', { decision: 'APPROVED', comment: '可以' });

    expect(prisma.tx.approvalDecision.create).toHaveBeenCalledWith({
      data: {
        approvalRequestId: 'approval-1',
        decision: 'APPROVED',
        comment: '可以',
        decidedById: 'approver-1',
      },
    });
    expect(prisma.tx.approvalRequest.updateMany).toHaveBeenCalledWith({
      where: { id: 'approval-1', approverId: 'approver-1', status: 'PENDING' },
      data: { status: 'APPROVED', processedAt: expect.any(Date) },
    });
    expect(prisma.tx.workLog.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'wl-1',
        status: 'SUBMITTED',
        currentVersionId: 'wlv-1',
        version: 3,
      },
      data: { status: 'APPROVED', version: { increment: 1 } },
    });
    expect(prisma.tx.projectEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        projectId: 'project-1',
        eventType: 'WORK_LOG_APPROVED',
        actorId: 'approver-1',
      }),
    });
    expect(prisma.tx.notification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'author-1',
        eventType: 'WORK_LOG_APPROVED',
        resourceType: 'WORK_LOG',
        resourceId: 'wl-1',
      }),
    });
    expect(prisma.tx.emailOutbox.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ toAddress: 'author@example.com' }),
    });
  });

  it('refuses a decision from someone who is not the designated approver', async () => {
    const service = createService(prisma);

    await expect(
      service.decide('someone-else', 'approval-1', { decision: 'APPROVED' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses to let the submitter approve their own log', async () => {
    prisma = createPrismaMock({ approverId: 'author-1' });
    const service = createService(prisma);

    await expect(
      service.decide('author-1', 'approval-1', { decision: 'APPROVED' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses a second decision on an already processed request', async () => {
    prisma = createPrismaMock({ status: 'APPROVED' });
    const service = createService(prisma);

    await expect(
      service.decide('approver-1', 'approval-1', { decision: 'RETURNED', comment: '再改改' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses when the work log is no longer waiting for this version', async () => {
    prisma = createPrismaMock();
    prisma.rawRequest.workLogVersion.workLog.currentVersionId = 'wlv-2';
    const service = createService(prisma);

    await expect(
      service.decide('approver-1', 'approval-1', { decision: 'APPROVED' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses when the work log left SUBMITTED behind the approval request', async () => {
    prisma = createPrismaMock();
    prisma.rawRequest.workLogVersion.workLog.status = 'DRAFT';
    const service = createService(prisma);

    await expect(
      service.decide('approver-1', 'approval-1', { decision: 'APPROVED' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('requires a comment when returning or rejecting', async () => {
    const service = createService(prisma);

    await expect(
      service.decide('approver-1', 'approval-1', { decision: 'RETURNED', comment: '   ' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.decide('approver-1', 'approval-1', { decision: 'REJECTED' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a decision after the approver was removed from the project', async () => {
    const prisma = createPrismaMock();
    const service = createService(prisma, { accessDenied: true });

    await expect(
      service.decide('approver-1', 'approval-1', { decision: 'APPROVED' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses a decision after the approver lost the approver role', async () => {
    const prisma = createPrismaMock();
    const service = createService(prisma, { roles: ['MEMBER'], permissions: [] });

    await expect(
      service.decide('approver-1', 'approval-1', { decision: 'APPROVED' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('still accepts an approver who holds approval:decide instead of the project role', async () => {
    const prisma = createPrismaMock();
    const service = createService(prisma, {
      roles: ['MEMBER'],
      permissions: [PERMISSIONS.APPROVAL_DECIDE],
    });

    await service.decide('approver-1', 'approval-1', { decision: 'APPROVED' });
    expect(prisma.tx.approvalDecision.create).toHaveBeenCalled();
  });

  it('refuses inside the transaction when the membership disappeared meanwhile', async () => {
    const prisma = createPrismaMock();
    prisma.tx.projectMembership.findFirst.mockResolvedValue(null);
    const service = createService(prisma);

    await expect(
      service.decide('approver-1', 'approval-1', { decision: 'APPROVED' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.tx.approvalDecision.create).not.toHaveBeenCalled();
  });

  it('refuses inside the transaction when the role was downgraded meanwhile', async () => {
    const prisma = createPrismaMock();
    prisma.tx.projectMembership.findFirst.mockResolvedValue({
      id: 'membership-1',
      roles: [{ role: 'MEMBER' }],
    });
    const service = createService(prisma, { roles: ['APPROVER'], permissions: [] });

    await expect(
      service.decide('approver-1', 'approval-1', { decision: 'APPROVED' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.tx.approvalDecision.create).not.toHaveBeenCalled();
  });

  it('refuses inside the transaction when the log was soft-deleted meanwhile', async () => {
    const prisma = createPrismaMock();
    prisma.tx.workLog.findFirst.mockResolvedValue(null);
    const service = createService(prisma);

    await expect(
      service.decide('approver-1', 'approval-1', { decision: 'APPROVED' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('maps a lost concurrency race into 409 instead of double-processing', async () => {
    const service = createService(prisma);
    prisma.tx.approvalRequest.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.decide('approver-1', 'approval-1', { decision: 'APPROVED' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.tx.approvalDecision.create).not.toHaveBeenCalled();
  });
});

describe('ApprovalsService.listPending', () => {
  it('only considers projects that are not archived when scoping the list', async () => {
    const prisma = createPrismaMock();
    const service = createService(prisma);

    await service.listPending('approver-1', { page: 1, pageSize: 10 });

    expect(prisma.projectMembership.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: 'approver-1',
          user: { status: 'ACTIVE', deletedAt: null },
          project: { status: { not: 'ARCHIVED' }, deletedAt: null },
        }),
      }),
    );
  });

  it('lists only the caller pending requests with paging', async () => {
    const prisma = createPrismaMock();
    const service = createService(prisma);

    await service.listPending('approver-1', { page: 2, pageSize: 10 });

    expect(prisma.approvalRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          approverId: 'approver-1',
          status: 'PENDING',
          workLogVersion: {
            workLog: {
              status: 'SUBMITTED',
              deletedAt: null,
              projectId: { in: ['project-1'] },
            },
          },
        },
        orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }],
        skip: 10,
        take: 10,
      }),
    );
  });
});
