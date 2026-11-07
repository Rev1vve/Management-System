import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PERMISSIONS } from '../authorization/permission.constants';
import { ReportsService } from './reports.service';

/**
 * 数据边界（D-027）：没有跨项目能力的人只能看自己的数字；
 * 有跨项目能力的人看授权项目聚合；明细下钻必须额外持有 `report:drilldown`。
 *
 * 工时口径：只统计**当前版本**且日志已离开 DRAFT —— 退回改版后旧版本仍在表里，
 * 对历史版本求和会把同一份工作重复计数。
 */
function createPrismaMock() {
  return {
    workLog: {
      findMany: vi.fn().mockResolvedValue([
        {
          projectId: 'project-1',
          project: { id: 'project-1', number: 'PRJ-1', name: '客户门户' },
          currentVersion: { hours: '4.5', workDate: new Date('2026-11-02T00:00:00.000Z') },
        },
        {
          projectId: 'project-1',
          project: { id: 'project-1', number: 'PRJ-1', name: '客户门户' },
          currentVersion: { hours: '2', workDate: new Date('2026-11-03T00:00:00.000Z') },
        },
        {
          projectId: 'project-2',
          project: { id: 'project-2', number: 'PRJ-2', name: '数据平台' },
          currentVersion: { hours: '6', workDate: new Date('2026-11-04T00:00:00.000Z') },
        },
      ]),
    },
    workLogVersion: { findMany: vi.fn().mockResolvedValue([]) },
    approvalRequest: { count: vi.fn().mockResolvedValue(3) },
    approvalDecision: {
      groupBy: vi.fn().mockResolvedValue([
        { decision: 'APPROVED', _count: { _all: 6 } },
        { decision: 'RETURNED', _count: { _all: 2 } },
        { decision: 'REJECTED', _count: { _all: 2 } },
      ]),
      findMany: vi.fn().mockResolvedValue([
        {
          decision: 'RETURNED',
          approvalRequest: { workLogVersion: { workLog: { projectId: 'project-1' } } },
        },
      ]),
    },
    project: {
      count: vi.fn().mockResolvedValue(2),
      findMany: vi.fn().mockResolvedValue([{ id: 'project-1' }, { id: 'project-2' }]),
    },
  };
}

function createService(
  prisma: ReturnType<typeof createPrismaMock>,
  permissions: string[] = [PERMISSIONS.PROJECT_VIEW],
) {
  const roles = { listUserPermissions: vi.fn().mockResolvedValue(permissions) };
  return { service: new ReportsService(prisma as never, roles as never), roles };
}

describe('ReportsService.summary', () => {
  let prisma: ReturnType<typeof createPrismaMock>;

  beforeEach(() => {
    prisma = createPrismaMock();
  });

  it('aggregates current versions inside the range for cross-project viewers', async () => {
    const { service } = createService(prisma, [PERMISSIONS.PROJECT_VIEW]);

    const result = await service.summary('pm-1', { from: '2026-11-01', to: '2026-11-07' });

    expect(result.scope).toBe('PROJECTS');
    expect(result.range).toEqual({
      from: '2026-11-01',
      to: '2026-11-07',
      timezone: 'Australia/Melbourne',
    });
    // 4.5 + 2 + 6（区间过滤已下推到 SQL，mocks 里只放区间内的行）。
    expect(result.hours.total).toBe(12.5);
    expect(result.hours.truncated).toBe(false);
    expect(result.approvals.pending).toBe(3);
    expect(result.approvals.pendingAsOf).toBe('2026-11-07');
    expect(result.approvals.decided).toEqual({ approved: 6, returned: 2, rejected: 2 });
    expect(result.approvals.returnRate).toBeCloseTo(0.2);
  });

  it('counts only the current version and skips drafts', async () => {
    const { service } = createService(prisma);

    await service.summary('pm-1', { from: '2026-11-01', to: '2026-11-07' });

    const call = prisma.workLog.findMany.mock.calls[0]?.[0] as {
      where: {
        status?: unknown;
        currentVersionId?: unknown;
        currentVersion?: { workDate?: unknown };
      };
    };
    expect(call.where.status).toEqual({ not: 'DRAFT' });
    expect(call.where.currentVersionId).toEqual({ not: null });
    // 日期过滤必须在查询里，而不是把全部历史日志拉进内存。
    expect(call.where.currentVersion).toEqual({
      workDate: { gte: expect.any(Date), lt: expect.any(Date) },
    });
    // 不再对版本表整体求和。
    expect(prisma.workLogVersion.findMany).not.toHaveBeenCalled();
  });

  it('scopes an employee without cross-project capability to their own logs', async () => {
    const { service } = createService(prisma, []);

    const result = await service.summary('employee-1', { from: '2026-11-01', to: '2026-11-07' });

    expect(result.scope).toBe('OWN');
    expect(prisma.workLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ authorId: 'employee-1', deletedAt: null }),
      }),
    );
    expect(prisma.project.findMany).not.toHaveBeenCalled();
  });

  it('rejects calendar dates that do not exist instead of failing later', async () => {
    const { service } = createService(prisma);

    await expect(
      service.summary('pm-1', { from: '2026-13-01', to: '2026-12-07' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.summary('pm-1', { from: '2026-02-31', to: '2026-03-07' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('bounds the summary query and reports truncation', async () => {
    const prisma = createPrismaMock();
    const { service } = createService(prisma);

    await service.summary('pm-1', { from: '2026-11-01', to: '2026-11-07' });

    expect(prisma.workLog.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 5001 }));
  });

  it('rejects a malformed or inverted range', async () => {
    const { service } = createService(prisma);

    await expect(
      service.summary('pm-1', { from: '2026-11-7', to: '2026-11-07' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.summary('pm-1', { from: '2026-11-07', to: '2026-11-01' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('returns a zero return rate when nothing was decided', async () => {
    prisma.approvalDecision.groupBy.mockResolvedValue([]);
    const { service } = createService(prisma);

    const result = await service.summary('pm-1', { from: '2026-11-01', to: '2026-11-07' });

    expect(result.approvals.decided).toEqual({ approved: 0, returned: 0, rejected: 0 });
    expect(result.approvals.returnRate).toBe(0);
  });
});

describe('ReportsService.byProject', () => {
  it('groups current-version hours and outcomes per project', async () => {
    const prisma = createPrismaMock();
    const { service } = createService(prisma);

    const result = await service.byProject('pm-1', { from: '2026-11-01', to: '2026-11-07' });

    expect(result.truncated).toBe(false);
    expect(result.items).toEqual([
      {
        projectId: 'project-1',
        number: 'PRJ-1',
        name: '客户门户',
        hours: 6.5,
        approved: 0,
        returned: 1,
        rejected: 0,
        returnRate: 1,
      },
      {
        projectId: 'project-2',
        number: 'PRJ-2',
        name: '数据平台',
        hours: 6,
        approved: 0,
        returned: 0,
        rejected: 0,
        returnRate: 0,
      },
    ]);
  });
});

describe('ReportsService.drilldown', () => {
  it('refuses before reading any project data without the drilldown capability', async () => {
    const prisma = createPrismaMock();
    const { service } = createService(prisma, [PERMISSIONS.PROJECT_VIEW]);

    await expect(
      service.drilldown('pm-1', 'project-1', { from: '2026-11-01', to: '2026-11-07' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    // 授权在取数之前：连项目清单都不该被扫描。
    expect(prisma.project.findMany).not.toHaveBeenCalled();
    expect(prisma.workLogVersion.findMany).not.toHaveBeenCalled();
  });

  it('refuses detail rows for a project outside the caller scope', async () => {
    const prisma = createPrismaMock();
    prisma.project.findMany.mockResolvedValue([{ id: 'project-1' }]);
    const { service } = createService(prisma, [
      PERMISSIONS.PROJECT_VIEW,
      PERMISSIONS.REPORT_DRILLDOWN,
    ]);

    await expect(
      service.drilldown('pm-1', 'project-2', { from: '2026-11-01', to: '2026-11-07' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('returns detail rows and an explicit truncation flag', async () => {
    const prisma = createPrismaMock();
    prisma.workLogVersion.findMany.mockResolvedValue([
      {
        versionNumber: 2,
        workDate: new Date('2026-11-06T00:00:00.000Z'),
        hours: '3',
        completion: '完成接口联调',
        workLog: {
          id: 'wl-1',
          number: 'WL-1',
          status: 'APPROVED',
          author: { id: 'author-1', name: '张三' },
        },
      },
    ]);
    const { service } = createService(prisma, [
      PERMISSIONS.PROJECT_VIEW,
      PERMISSIONS.REPORT_DRILLDOWN,
    ]);

    const result = await service.drilldown('exec-1', 'project-1', {
      from: '2026-11-01',
      to: '2026-11-07',
    });

    expect(result.truncated).toBe(false);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toEqual(
      expect.objectContaining({ workLogId: 'wl-1', hours: 3, completion: '完成接口联调' }),
    );
  });
});
