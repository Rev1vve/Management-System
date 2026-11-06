import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PERMISSIONS } from '../authorization/permission.constants';
import { WorkLogsService } from './work-logs.service';

/**
 * Task 8 第一片：工作日志草稿创建。
 *
 * 约束（主计划 §4.2 D-A/D-B/D-E）：
 *  - 只有项目成员能在项目内创建日志；非成员与不存在项目同为 404（防枚举）。
 *  - 草稿默认 PRIVATE；可见性写权仅限"项目内 PROJECT_MANAGER"或持有 worklog:manage 能力。
 *  - 创建时同时落 WorkLog + versionNumber=1 的 WorkLogVersion，并把 currentVersionId 指向该版本。
 *  - 非法输入必须在任何写操作之前拒绝。
 */
function createPrismaMock() {
  const tx = {
    workLog: {
      create: vi.fn().mockResolvedValue({ id: 'wl-1', number: 'WL-20260101-ABCDEF' }),
      update: vi.fn().mockResolvedValue({ id: 'wl-1' }),
    },
    workLogVersion: {
      create: vi.fn().mockResolvedValue({ id: 'wlv-1', versionNumber: 1 }),
    },
    order: { findFirst: vi.fn().mockResolvedValue({ id: 'order-1' }) },
    orderItem: { findFirst: vi.fn().mockResolvedValue({ id: 'item-1' }) },
  };
  const prisma = {
    $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
    workLog: { create: vi.fn(), update: vi.fn(), findFirst: vi.fn() },
    workLogVersion: { create: vi.fn() },
    tx,
  };
  return prisma;
}

function createService(
  prisma: ReturnType<typeof createPrismaMock>,
  overrides?: {
    assertProjectAccess?: ReturnType<typeof vi.fn>;
    listUserPermissions?: ReturnType<typeof vi.fn>;
  },
) {
  const projectAccess = {
    assertProjectAccess:
      overrides?.assertProjectAccess ?? vi.fn().mockResolvedValue({ roles: ['MEMBER'] }),
  };
  const roles = {
    listUserPermissions: overrides?.listUserPermissions ?? vi.fn().mockResolvedValue([]),
  };
  const service = new WorkLogsService(prisma as never, projectAccess as never, roles as never);
  return { service, projectAccess, roles };
}

const baseInput = {
  projectId: 'project-1',
  workDate: '2026-11-06',
  hours: 7.5,
  completion: '完成客户需求梳理与接口对齐',
};

describe('WorkLogsService createDraft', () => {
  let prisma: ReturnType<typeof createPrismaMock>;

  beforeEach(() => {
    prisma = createPrismaMock();
  });

  it('rejects a non-member with 404 and writes nothing', async () => {
    const assertProjectAccess = vi.fn().mockRejectedValue(new NotFoundException('项目不存在'));
    const { service } = createService(prisma, { assertProjectAccess });

    await expect(service.createDraft('user-1', baseInput)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.tx.workLog.create).not.toHaveBeenCalled();
  });

  it('creates a draft with PRIVATE visibility, version 1 and a current version pointer', async () => {
    const { service } = createService(prisma);

    const result = await service.createDraft('user-1', baseInput);

    expect(result).toEqual({ id: 'wl-1', number: 'WL-20260101-ABCDEF', versionNumber: 1 });
    expect(prisma.tx.workLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          authorId: 'user-1',
          projectId: 'project-1',
          status: 'DRAFT',
          visibility: 'PRIVATE',
        }),
      }),
    );
    expect(prisma.tx.workLogVersion.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          workLogId: 'wl-1',
          versionNumber: 1,
          submittedById: 'user-1',
        }),
      }),
    );
    expect(prisma.tx.workLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'wl-1' },
        data: { currentVersionId: 'wlv-1' },
      }),
    );
  });

  it('rejects a member without visibility rights who requests PROJECT visibility', async () => {
    const { service } = createService(prisma);

    await expect(
      service.createDraft('user-1', { ...baseInput, visibility: 'PROJECT_VISIBLE' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('allows a project manager to publish with PROJECT visibility', async () => {
    const assertProjectAccess = vi.fn().mockResolvedValue({ roles: ['PROJECT_MANAGER'] });
    const { service } = createService(prisma, { assertProjectAccess });

    await service.createDraft('user-1', { ...baseInput, visibility: 'PROJECT_VISIBLE' });

    expect(prisma.tx.workLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ visibility: 'PROJECT_VISIBLE' }),
      }),
    );
  });

  it('allows a holder of worklog:manage to set visibility even without the project manager role', async () => {
    const listUserPermissions = vi.fn().mockResolvedValue([PERMISSIONS.WORKLOG_MANAGE]);
    const { service } = createService(prisma, { listUserPermissions });

    await service.createDraft('user-1', { ...baseInput, visibility: 'PROJECT_VISIBLE' });

    expect(prisma.tx.workLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ visibility: 'PROJECT_VISIBLE' }),
      }),
    );
  });

  it.each([1.15, 2.55, 4.35, 0.07, 7.5])('accepts exactly-two-decimal hours %s', async (hours) => {
    const { service } = createService(prisma);

    await service.createDraft('user-1', { ...baseInput, hours });

    expect(prisma.tx.workLog.create).toHaveBeenCalledOnce();
    expect(prisma.tx.workLogVersion.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ hours: hours.toFixed(2) }) }),
    );
  });

  it('rejects three-decimal hours', async () => {
    const { service } = createService(prisma);

    await expect(
      service.createDraft('user-1', { ...baseInput, hours: 1.155 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects an order that belongs to another project', async () => {
    prisma.tx.order.findFirst.mockResolvedValue(null);
    const { service } = createService(prisma);

    await expect(
      service.createDraft('user-1', { ...baseInput, orderId: 'foreign-order' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.tx.order.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'foreign-order', projectId: 'project-1' }),
      }),
    );
    expect(prisma.tx.workLog.create).not.toHaveBeenCalled();
  });

  it('rejects an order item without its order', async () => {
    const { service } = createService(prisma);

    await expect(
      service.createDraft('user-1', { ...baseInput, orderItemId: 'item-1' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.tx.workLog.create).not.toHaveBeenCalled();
  });

  it('rejects an archived or deleted order reference', async () => {
    prisma.tx.order.findFirst.mockResolvedValue(null);
    const { service } = createService(prisma);

    await expect(
      service.createDraft('user-1', { ...baseInput, orderId: 'archived-order' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.tx.order.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'archived-order',
          projectId: 'project-1',
          deletedAt: null,
          status: { not: 'ARCHIVED' },
        }),
      }),
    );
  });

  it.each([
    ['hours above 24', { hours: 24.5 }],
    ['negative hours', { hours: -1 }],
    ['zero hours', { hours: 0 }],
    ['hours with three decimals', { hours: 1.234 }],
    ['malformed work date', { workDate: '2026/11/06' }],
    ['impossible work date', { workDate: '2026-02-31' }],
    ['blank completion', { completion: '   ' }],
    ['unknown field', { authorId: 'attacker' }],
    ['unknown visibility', { visibility: 'PUBLIC' }],
  ])('rejects %s before any write', async (_label, patch) => {
    const { service } = createService(prisma);

    await expect(
      service.createDraft('user-1', { ...baseInput, ...patch } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
