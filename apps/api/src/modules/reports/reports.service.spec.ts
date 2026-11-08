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
      findMany: vi.fn().mockResolvedValue([
        { id: 'project-1' },
        { id: 'project-2' },
        {
          id: 'project-1',
          number: 'PRJ-1',
          name: '客户门户',
          status: 'ACTIVE',
          completionPercent: 40,
        },
      ]),
    },
    projectMembership: { findMany: vi.fn().mockResolvedValue([{ projectId: 'project-1' }]) },
    portfolioMembership: {
      findMany: vi
        .fn()
        .mockResolvedValue([{ portfolioId: 'pf-1', portfolio: { id: 'pf-1', name: '政企线' } }]),
      count: vi.fn().mockResolvedValue(1),
    },
    portfolio: {
      findMany: vi.fn().mockResolvedValue([{ id: 'pf-1', name: '政企线' }]),
      count: vi.fn().mockResolvedValue(1),
    },
  };
}

function createService(
  prisma: ReturnType<typeof createPrismaMock>,
  permissions: string[] = [PERMISSIONS.PROJECT_VIEW],
) {
  const roles = {
    // 默认按"高层"处理：作用域是全部非归档项目（方案 A 第一条分支）。
    listUserPermissions: vi.fn().mockResolvedValue([...permissions, PERMISSIONS.REPORT_VIEW_ALL]),
  };
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
    // 快照日期是真实业务日（今天），不是区间结束日。
    expect(result.approvals.pendingAsOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result.approvals.pendingAsOf).not.toBe('2026-11-07');
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

  it('exposes truncation reasons and the server-side limit', async () => {
    const prisma = createPrismaMock();
    const { service } = createService(prisma);

    const summary = await service.summary('pm-1', { from: '2026-11-01', to: '2026-11-07' });
    expect(summary.hours.truncated).toBe(false);
    expect(summary.hours.truncatedReason).toBeNull();
    expect(summary.hours.limit).toBe(5000);
    // 待审是实时快照：标注的是"今天"，不是区间结束日。
    expect(summary.approvals.pendingAsOf).not.toBe('2026-11-07');

    const byProject = await service.byProject('pm-1', { from: '2026-11-01', to: '2026-11-07' });
    expect(byProject.truncatedReasons).toEqual([]);
    expect(byProject.limit).toBe(5000);
  });

  it('reports the row limit when the summary query is truncated', async () => {
    const prisma = createPrismaMock();
    prisma.workLog.findMany.mockResolvedValue(
      Array.from({ length: 5001 }, () => ({
        projectId: 'project-1',
        project: { id: 'project-1', number: 'PRJ-1', name: '客户门户' },
        currentVersion: { hours: '1' },
      })),
    );
    const { service } = createService(prisma);

    const summary = await service.summary('pm-1', { from: '2026-11-01', to: '2026-11-07' });

    expect(summary.hours.truncated).toBe(true);
    expect(summary.hours.truncatedReason).toBe('ROW_LIMIT');
    expect(summary.hours.total).toBe(5000);
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

  it('limits managed projects to the ones the caller really manages', async () => {
    const prisma = createPrismaMock();
    prisma.projectMembership.findMany.mockResolvedValue([{ projectId: 'project-1' }]);
    prisma.project.findMany.mockResolvedValue([
      {
        id: 'project-1',
        number: 'PRJ-1',
        name: '客户门户',
        status: 'ACTIVE',
        completionPercent: 40,
      },
      // 区间内没有活动的项目也必须在清单里（数字为 0）。
      {
        id: 'project-9',
        number: 'PRJ-9',
        name: '零活动项目',
        status: 'ON_HOLD',
        completionPercent: 10,
      },
    ]);
    const { service } = createService(prisma, [
      PERMISSIONS.PROJECT_VIEW,
      PERMISSIONS.PROJECT_MANAGE,
    ]);

    const result = await service.managedProjects('pm-1', { from: '2026-11-01', to: '2026-11-07' });

    expect(result.projectsManaged).toBe(2);
    expect(result.items.map((row) => row.projectId)).toEqual(['project-1', 'project-9']);
    expect(result.items[0]).toEqual(
      expect.objectContaining({ projectId: 'project-1', status: 'ACTIVE', completionPercent: 40 }),
    );
    // 零活动项目仍出现，且数字为 0。
    expect(result.items[1]).toEqual(
      expect.objectContaining({ projectId: 'project-9', hours: 0, approved: 0, returnRate: 0 }),
    );
    // 作用域是"我管理的项目"，不是"全部项目"。
    expect(prisma.workLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ projectId: { in: ['project-1'] }, deletedAt: null }),
      }),
    );
  });

  it('returns an empty page when the caller manages nothing', async () => {
    const prisma = createPrismaMock();
    prisma.projectMembership.findMany.mockResolvedValue([]);
    const { service } = createService(prisma);

    const result = await service.managedProjects('employee-1', {
      from: '2026-11-01',
      to: '2026-11-07',
    });

    expect(result.items).toEqual([]);
    expect(result.projectsManaged).toBe(0);
    expect(prisma.workLog.findMany).not.toHaveBeenCalled();
  });

  it('limits portfolio rows to portfolios the caller belongs to', async () => {
    const prisma = createPrismaMock();
    prisma.portfolioMembership.findMany.mockResolvedValue([
      { portfolioId: 'pf-1', portfolio: { id: 'pf-1', name: '政企线' } },
    ]);
    prisma.project.findMany.mockResolvedValue([{ id: 'project-1', portfolioId: 'pf-1' }]);
    const roles = { listUserPermissions: vi.fn().mockResolvedValue([PERMISSIONS.PORTFOLIO_VIEW]) };
    const service = new ReportsService(prisma as never, roles as never);

    const result = await service.portfolios('director-1', { from: '2026-11-01', to: '2026-11-07' });

    expect(result.items).toEqual([
      expect.objectContaining({
        portfolioId: 'pf-1',
        name: '政企线',
        projects: 1,
        // 只有 pf-1 下的 project-1 计入（4.5 + 2），project-2 属于别的项目集。
        hours: 6.5,
        returned: 1,
      }),
    ]);
  });

  it('returns nothing when the caller belongs to no portfolio', async () => {
    const prisma = createPrismaMock();
    prisma.portfolioMembership.findMany.mockResolvedValue([]);
    const roles = { listUserPermissions: vi.fn().mockResolvedValue([]) };
    const service = new ReportsService(prisma as never, roles as never);

    const result = await service.portfolios('exec-1', { from: '2026-11-01', to: '2026-11-07' });

    expect(result.items).toEqual([]);
    expect(prisma.project.findMany).not.toHaveBeenCalled();
  });

  it('excludes archived projects from the employee scope and the in-scope count', async () => {
    const prisma = createPrismaMock();
    const { service } = createService(prisma, []);

    await service.summary('employee-1', { from: '2026-11-01', to: '2026-11-07' });

    const call = prisma.workLog.findMany.mock.calls[0]?.[0] as {
      where: Record<string, unknown>;
    };
    expect(call.where.project).toEqual({
      status: { not: 'ARCHIVED' },
      deletedAt: null,
    });
    expect(prisma.project.count).toHaveBeenCalledWith({
      where: {
        status: { not: 'ARCHIVED' },
        deletedAt: null,
        workLogs: { some: { authorId: 'employee-1', deletedAt: null } },
      },
    });
  });

  it('scopes the cross-project report set to non-archived projects', async () => {
    const prisma = createPrismaMock();
    const roles = {
      listUserPermissions: vi
        .fn()
        .mockResolvedValue([PERMISSIONS.PROJECT_VIEW, PERMISSIONS.REPORT_VIEW_ALL]),
    };
    const service = new ReportsService(prisma as never, roles as never);

    await service.byProject('exec-1', { from: '2026-11-01', to: '2026-11-07' });

    expect(prisma.project.findMany).toHaveBeenCalledWith({
      where: { status: { not: 'ARCHIVED' }, deletedAt: null },
      select: { id: true },
    });
  });

  it('keeps the portfolio total when every membership points at an archived portfolio', async () => {
    const prisma = createPrismaMock();
    prisma.portfolioMembership.count.mockResolvedValue(2);
    prisma.portfolioMembership.findMany.mockResolvedValue([]);
    const roles = { listUserPermissions: vi.fn().mockResolvedValue([]) };
    const service = new ReportsService(prisma as never, roles as never);

    const result = await service.portfolios('director-1', {
      from: '2026-11-01',
      to: '2026-11-07',
    });

    expect(result.items).toEqual([]);
    // 归属还在，只是都归档了：不能被读成"你不属于任何项目集"。
    expect(result.portfoliosTotal).toBe(2);
    expect(prisma.portfolioMembership.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          portfolio: { status: { not: 'ARCHIVED' }, deletedAt: null },
        }),
      }),
    );
  });

  it('narrows a portfolio director to the projects inside their portfolios', async () => {
    const prisma = createPrismaMock();
    prisma.projectMembership.findMany.mockResolvedValue([{ projectId: 'project-9' }]);
    prisma.portfolioMembership.findMany.mockResolvedValue([{ portfolioId: 'pf-1' }]);
    prisma.project.findMany.mockResolvedValue([{ id: 'project-in-portfolio' }]);
    const roles = {
      listUserPermissions: vi
        .fn()
        .mockResolvedValue([PERMISSIONS.PROJECT_VIEW, PERMISSIONS.PORTFOLIO_VIEW]),
    };
    const service = new ReportsService(prisma as never, roles as never);

    await service.summary('director-1', { from: '2026-11-01', to: '2026-11-07' });

    // 总监看不到项目集之外的项目（之前是"全部非归档项目"）。
    expect(prisma.workLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ projectId: { in: ['project-in-portfolio'] } }),
      }),
    );
    expect(prisma.project.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ portfolioId: { in: ['pf-1'] } }),
      }),
    );
  });

  it('narrows a project manager without portfolios to their own projects', async () => {
    const prisma = createPrismaMock();
    prisma.portfolioMembership.findMany.mockResolvedValue([]);
    prisma.projectMembership.findMany.mockResolvedValue([{ projectId: 'project-7' }]);
    const roles = {
      listUserPermissions: vi
        .fn()
        .mockResolvedValue([PERMISSIONS.PROJECT_VIEW, PERMISSIONS.PROJECT_MANAGE]),
    };
    const service = new ReportsService(prisma as never, roles as never);

    await service.summary('pm-1', { from: '2026-11-01', to: '2026-11-07' });

    expect(prisma.workLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ projectId: { in: ['project-7'] } }),
      }),
    );
  });

  it('reports both the scope size and the projects that had activity', async () => {
    const prisma = createPrismaMock();
    const { service } = createService(prisma);

    const summary = await service.summary('pm-1', { from: '2026-11-01', to: '2026-11-07' });

    // 作用域 2 个项目，区间内只有 project-1 / project-2 有工时；两个字段分开给，
    // 页面才能解释"范围内 N 个、本区间有记录 M 个"。
    expect(summary.projects.inScope).toBe(2);
    expect(summary.projects.withActivity).toBe(2);
  });

  it('lets an org-wide viewer aggregate every portfolio, not just memberships', async () => {
    const prisma = createPrismaMock();
    prisma.portfolio.findMany.mockResolvedValue([
      { id: 'pf-1', name: '政企线' },
      { id: 'pf-2', name: '金融线' },
    ]);
    prisma.portfolio.count.mockResolvedValue(2);
    prisma.project.findMany.mockResolvedValue([{ id: 'project-1', portfolioId: 'pf-1' }]);
    const roles = {
      listUserPermissions: vi
        .fn()
        .mockResolvedValue([PERMISSIONS.PROJECT_VIEW, PERMISSIONS.REPORT_VIEW_ALL]),
    };
    const service = new ReportsService(prisma as never, roles as never);

    const result = await service.portfolios('exec-1', { from: '2026-11-01', to: '2026-11-07' });

    expect(prisma.portfolioMembership.findMany).not.toHaveBeenCalled();
    expect(result.portfoliosTotal).toBe(2);
    expect(result.items.map((row) => row.portfolioId)).toEqual(['pf-1']);
  });
});
