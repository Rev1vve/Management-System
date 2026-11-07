import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PERMISSIONS } from '../authorization/permission.constants';
import { WorkLogsService } from './work-logs.service';

/**
 * 任务 8 的事件挂点（为任务 9 的站内通知/时间线供数）。
 *
 * 约束：
 *  - 事件必须与业务变更在**同一事务**内写入（失败即一起回滚）；
 *  - 摘要只允许出现 ID/编号/状态/版本号，**不得包含正文、工时、审批意见等私有内容**。
 */
function createPrismaMock(log: Record<string, unknown> | null = null) {
  const tx = {
    workLog: {
      create: vi.fn().mockResolvedValue({ id: 'wl-1', number: 'WL-20261106-AAAA' }),
      update: vi.fn().mockResolvedValue({ id: 'wl-1' }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: vi.fn().mockResolvedValue({ version: 1 }),
    },
    workLogVersion: {
      create: vi.fn().mockResolvedValue({ id: 'wlv-2', versionNumber: 2 }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      aggregate: vi.fn().mockResolvedValue({ _max: { versionNumber: 1 } }),
    },
    projectMembership: { findFirst: vi.fn().mockResolvedValue({ id: 'membership-1' }) },
    order: { findFirst: vi.fn().mockResolvedValue({ id: 'order-1' }) },
    orderItem: { findFirst: vi.fn().mockResolvedValue({ id: 'item-1' }) },
    attachment: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    approvalRequest: { create: vi.fn().mockResolvedValue({ id: 'approval-1' }) },
    projectEvent: { create: vi.fn().mockResolvedValue({ id: 'event-1' }) },
  };
  const prisma = {
    workLog: {
      findFirst: vi.fn().mockResolvedValue(log),
      count: vi.fn().mockResolvedValue(1),
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
    tx,
  };
  return prisma;
}

function createService(prisma: ReturnType<typeof createPrismaMock>) {
  const projectAccess = {
    assertProjectAccess: vi.fn().mockResolvedValue({ roles: ['MEMBER'] }),
  };
  const roles = { listUserPermissions: vi.fn().mockResolvedValue([]) };
  return new WorkLogsService(prisma as never, projectAccess as never, roles as never);
}

const content = { workDate: '2026-11-06', hours: 3, completion: '正文内容不应出现在事件里' };

describe('WorkLogsService project events', () => {
  let prisma: ReturnType<typeof createPrismaMock>;

  beforeEach(() => {
    prisma = createPrismaMock();
  });

  it('records WORK_LOG_CREATED without leaking the completion text', async () => {
    const service = createService(prisma);

    await service.createDraft('author-1', { ...content, projectId: 'project-1' });

    expect(prisma.tx.projectEvent.create).toHaveBeenCalledWith({
      data: {
        projectId: 'project-1',
        eventType: 'WORK_LOG_CREATED',
        summary: '工作日志 WL-20261106-AAAA 已创建（DRAFT）',
        actorId: 'author-1',
      },
    });
    const summary = prisma.tx.projectEvent.create.mock.calls[0]![0].data.summary as string;
    expect(summary).not.toContain(content.completion);
  });

  it('records WORK_LOG_SUBMITTED inside the submission transaction', async () => {
    prisma = createPrismaMock({
      id: 'wl-1',
      number: 'WL-1',
      authorId: 'author-1',
      projectId: 'project-1',
      status: 'DRAFT',
      currentVersionId: 'wlv-1',
    });
    const service = createService(prisma);

    await service.submit('author-1', 'wl-1', { approverId: 'approver-1' });

    expect(prisma.tx.projectEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          projectId: 'project-1',
          eventType: 'WORK_LOG_SUBMITTED',
          actorId: 'author-1',
        }),
      }),
    );
  });

  it('records WORK_LOG_VERSION_CREATED with the new version number only', async () => {
    prisma = createPrismaMock({
      id: 'wl-1',
      number: 'WL-1',
      authorId: 'author-1',
      projectId: 'project-1',
      status: 'RETURNED',
      currentVersionId: 'wlv-1',
    });
    const service = createService(prisma);

    await service.addVersion('author-1', 'wl-1', content);

    expect(prisma.tx.projectEvent.create).toHaveBeenCalledWith({
      data: {
        projectId: 'project-1',
        eventType: 'WORK_LOG_VERSION_CREATED',
        summary: '工作日志 WL-1 新增版本 v2（DRAFT）',
        actorId: 'author-1',
      },
    });
  });

  it('records WORK_LOG_VISIBILITY_CHANGED and stays silent about content', async () => {
    prisma = createPrismaMock({
      id: 'wl-1',
      number: 'WL-1',
      authorId: 'author-1',
      projectId: 'project-1',
      status: 'DRAFT',
      visibility: 'PRIVATE',
      version: 1,
    });
    const service = new WorkLogsService(
      prisma as never,
      { assertProjectAccess: vi.fn().mockResolvedValue({ roles: ['PROJECT_MANAGER'] }) } as never,
      { listUserPermissions: vi.fn().mockResolvedValue([PERMISSIONS.WORKLOG_MANAGE]) } as never,
    );

    await service.setVisibility('pm-1', 'wl-1', { visibility: 'PROJECT_VISIBLE', version: 1 });

    expect(prisma.tx.projectEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: 'WORK_LOG_VISIBILITY_CHANGED',
          summary: '工作日志 WL-1 可见性变更为 PROJECT_VISIBLE',
          actorId: 'pm-1',
        }),
      }),
    );
  });
});
