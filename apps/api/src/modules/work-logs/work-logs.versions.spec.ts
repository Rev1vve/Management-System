import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { WorkLogsService } from './work-logs.service';

/**
 * Task 8 第三片：退回后开新版本 + 草稿编辑。
 *
 * 约束（主计划 §4.2 D-E）：
 *  - 仅作者本人；他人一律 404（防枚举）。
 *  - 只有 RETURNED 能开新版本（versionNumber = max+1），成功后状态回 DRAFT，
 *    currentVersionId 指向新版本，旧的 WorkLogVersion 与审批历史一行不改。
 *  - 只有 DRAFT 能编辑当前版本；已提交/已通过/已退回/已拒绝一律 409。
 *  - 作者必须仍是该项目有效成员。
 */
function createPrismaMock(log: Record<string, unknown> | null) {
  const tx = {
    workLogVersion: {
      aggregate: vi.fn().mockResolvedValue({ _max: { versionNumber: 2 } }),
      create: vi.fn().mockResolvedValue({ id: 'wlv-3', versionNumber: 3 }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    workLog: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: vi.fn().mockResolvedValue({ version: 5 }),
      findFirstOrThrow: vi.fn().mockResolvedValue({ id: 'wl-1', version: 6 }),
    },
    projectMembership: { findFirst: vi.fn().mockResolvedValue({ id: 'membership-1' }) },
    projectEvent: { create: vi.fn().mockResolvedValue({ id: 'event-1' }) },
    order: { findFirst: vi.fn().mockResolvedValue({ id: 'order-1' }) },
    orderItem: { findFirst: vi.fn().mockResolvedValue({ id: 'item-1' }) },
  };
  const prisma = {
    workLog: { findFirst: vi.fn().mockResolvedValue(log) },
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

const returnedLog = {
  id: 'wl-1',
  authorId: 'author-1',
  projectId: 'project-1',
  status: 'RETURNED',
  currentVersionId: 'wlv-2',
};

const content = {
  workDate: '2026-11-07',
  hours: 6.5,
  completion: '按审批意见补充了交付物清单',
};

describe('WorkLogsService addVersion', () => {
  let prisma: ReturnType<typeof createPrismaMock>;

  beforeEach(() => {
    prisma = createPrismaMock({ ...returnedLog });
  });

  it('creates versionNumber max+1 and returns the log to DRAFT', async () => {
    const service = createService(prisma);

    const result = await service.addVersion('author-1', 'wl-1', content);

    // 必须返回乐观并发令牌（workLog.version 自增后的值），否则 PATCH 无法继续编辑。
    expect(result).toEqual({ id: 'wl-1', status: 'DRAFT', versionNumber: 3, version: 6 });
    expect(prisma.tx.workLogVersion.aggregate).toHaveBeenCalledWith({
      where: { workLogId: 'wl-1' },
      _max: { versionNumber: true },
    });
    expect(prisma.tx.workLogVersion.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          workLogId: 'wl-1',
          versionNumber: 3,
          submittedById: 'author-1',
          completion: content.completion,
          hours: '6.50',
        }),
      }),
    );
    expect(prisma.tx.workLog.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'wl-1',
          authorId: 'author-1',
          status: 'RETURNED',
          currentVersionId: 'wlv-2',
          deletedAt: null,
        }),
        data: expect.objectContaining({ status: 'DRAFT', currentVersionId: 'wlv-3' }),
      }),
    );
  });

  it('scopes the ownership lookup by authorId and not-deleted', async () => {
    const service = createService(prisma);

    await service.addVersion('author-1', 'wl-1', content);

    expect(prisma.workLog.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'wl-1', authorId: 'author-1', deletedAt: null },
      }),
    );
  });

  it('runs the version insert inside a Serializable transaction', async () => {
    const service = createService(prisma);

    await service.addVersion('author-1', 'wl-1', content);

    expect(prisma.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ isolationLevel: 'Serializable' }),
    );
  });

  it('rejects another user with 404 and writes nothing', async () => {
    prisma = createPrismaMock(null);
    const service = createService(prisma);

    await expect(service.addVersion('intruder', 'wl-1', content)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each(['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED'])(
    'rejects a new version from %s status with 409',
    async (status) => {
      prisma = createPrismaMock({ ...returnedLog, status });
      const service = createService(prisma);

      await expect(service.addVersion('author-1', 'wl-1', content)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    },
  );

  it('returns 404 when the author is no longer an active project member', async () => {
    prisma.tx.projectMembership.findFirst.mockResolvedValue(null);
    const service = createService(prisma);

    await expect(service.addVersion('author-1', 'wl-1', content)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.tx.workLogVersion.create).not.toHaveBeenCalled();
  });

  it('returns 409 when the compare-and-set loses a race', async () => {
    prisma.tx.workLog.updateMany.mockResolvedValue({ count: 0 });
    const service = createService(prisma);

    await expect(service.addVersion('author-1', 'wl-1', content)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('maps a concurrent unique-constraint collision to 409', async () => {
    prisma.$transaction.mockRejectedValue(
      Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }),
    );
    const service = createService(prisma);

    await expect(service.addVersion('author-1', 'wl-1', content)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('persists the order reference and clears a stale item link', async () => {
    const service = createService(prisma);

    await service.addVersion('author-1', 'wl-1', { ...content, orderId: 'order-1' });

    expect(prisma.tx.workLog.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ orderId: 'order-1', orderItemId: null }),
      }),
    );
  });

  it('rejects unknown fields before touching the database', async () => {
    const service = createService(prisma);

    await expect(
      service.addVersion('author-1', 'wl-1', { ...content, status: 'APPROVED' } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects an order that belongs to another project', async () => {
    prisma.tx.order.findFirst.mockResolvedValue(null);
    const service = createService(prisma);

    await expect(
      service.addVersion('author-1', 'wl-1', { ...content, orderId: 'foreign-order' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.tx.workLogVersion.create).not.toHaveBeenCalled();
  });
});

describe('WorkLogsService updateDraft', () => {
  let prisma: ReturnType<typeof createPrismaMock>;

  beforeEach(() => {
    prisma = createPrismaMock({
      id: 'wl-1',
      authorId: 'author-1',
      projectId: 'project-1',
      status: 'DRAFT',
      currentVersionId: 'wlv-1',
    });
  });

  it('updates the current version content and bumps the optimistic version', async () => {
    const service = createService(prisma);

    await service.updateDraft('author-1', 'wl-1', content, 1);

    expect(prisma.tx.workLogVersion.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'wlv-1', workLogId: 'wl-1' },
        data: expect.objectContaining({ completion: content.completion, hours: '6.50' }),
      }),
    );
    expect(prisma.tx.workLog.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'wl-1',
          status: 'DRAFT',
          currentVersionId: 'wlv-1',
          version: 1,
        }),
        data: expect.objectContaining({ version: { increment: 1 } }),
      }),
    );
  });

  it.each(['SUBMITTED', 'APPROVED', 'RETURNED', 'REJECTED'])(
    'rejects editing a %s log with 409',
    async (status) => {
      prisma = createPrismaMock({
        id: 'wl-1',
        authorId: 'author-1',
        projectId: 'project-1',
        status,
        currentVersionId: 'wlv-1',
      });
      const service = createService(prisma);

      await expect(service.updateDraft('author-1', 'wl-1', content, 1)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    },
  );

  it('rejects another user with 404', async () => {
    prisma = createPrismaMock(null);
    const service = createService(prisma);

    await expect(service.updateDraft('intruder', 'wl-1', content, 1)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('returns 409 when the caller version is stale', async () => {
    prisma.tx.workLog.updateMany.mockResolvedValue({ count: 0 });
    const service = createService(prisma);

    await expect(service.updateDraft('author-1', 'wl-1', content, 7)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(prisma.tx.workLogVersion.updateMany).not.toHaveBeenCalled();
  });

  it('persists the order reference on the work log instead of silently dropping it', async () => {
    const service = createService(prisma);

    await service.updateDraft('author-1', 'wl-1', { ...content, orderId: 'order-1' }, 1);

    expect(prisma.tx.workLog.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ orderId: 'order-1' }) }),
    );
  });

  it('rejects a malformed version before touching the database', async () => {
    const service = createService(prisma);

    await expect(service.updateDraft('author-1', 'wl-1', content, 0)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      service.updateDraft('author-1', 'wl-1', content, 'abc' as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('fails closed when the draft has no current version', async () => {
    prisma = createPrismaMock({
      id: 'wl-1',
      authorId: 'author-1',
      projectId: 'project-1',
      status: 'DRAFT',
      currentVersionId: null,
    });
    const service = createService(prisma);

    await expect(service.updateDraft('author-1', 'wl-1', content, 1)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('WorkLogsService getDetail', () => {
  it('returns the optimistic version token and the current version for the author', async () => {
    const prisma = createPrismaMock({ ...returnedLog, status: 'DRAFT', currentVersionId: 'wlv-1' });
    prisma.tx.workLog.findFirstOrThrow.mockResolvedValue({
      id: 'wl-1',
      status: 'DRAFT',
      version: 4,
      currentVersion: { versionNumber: 2 },
    });
    const service = new WorkLogsService(
      {
        ...prisma,
        workLog: {
          findFirst: prisma.workLog.findFirst,
          findFirstOrThrow: prisma.tx.workLog.findFirstOrThrow,
        },
      } as never,
      { assertProjectAccess: vi.fn() } as never,
      { listUserPermissions: vi.fn() } as never,
    );

    const detail = await service.getDetail('author-1', 'wl-1');

    expect(detail).toMatchObject({ version: 4, currentVersion: { versionNumber: 2 } });
  });

  it('returns 404 for another user', async () => {
    const prisma = createPrismaMock(null);
    const service = createService(prisma);

    await expect(service.getDetail('intruder', 'wl-1')).rejects.toBeInstanceOf(NotFoundException);
  });
});
