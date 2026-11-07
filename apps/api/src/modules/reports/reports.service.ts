import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';

import { PrismaService } from '../../database/prisma.service';
import { PERMISSIONS } from '../authorization/permission.constants';
import { RolesService } from '../roles/roles.service';
import {
  BUSINESS_TIMEZONE,
  todayInBusinessZone,
  zonedDayEndExclusiveUtc,
  zonedDayStartUtc,
} from './business-time';

interface RangeInput {
  from?: string | null;
  to?: string | null;
}

interface ResolvedRange {
  from: string;
  to: string;
  /** 业务日区间在 UTC 上的瞬时（用于 timestamptz 列，如 decidedAt）。 */
  fromUtc: Date;
  toUtcExclusive: Date;
  /** work_date 是纯日期列：按日期字面边界比较，避免时区换算后被截断成前一天。 */
  fromDate: Date;
  toDateExclusive: Date;
  timezone: string;
}

type Scope = { kind: 'OWN'; userId: string } | { kind: 'PROJECTS'; projectIds: string[] };

const REPORT_ROW_LIMIT = 5000;
const DETAIL_ROW_LIMIT = 200;

/** 正则通过但日历上不存在的日期（2026-13-01、2026-02-31）必须拒绝，不能变成 Prisma 500。 */
function isRealCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * 报表（任务 10）。
 *
 * 数据边界（D-027 / D-039 / D-041）：
 *  - 没有跨项目能力（`project:view`）的人只看**自己的**工时与审批结果；
 *  - 有跨项目能力的人看**授权项目**的聚合，仍然看不到别人日志的正文；
 *  - 客户/个人级明细必须额外持有 `report:drilldown`（默认不授予任何角色）。
 * 聚合永远先过作用域，再算数——不存在"先聚合再按权限过滤"的路径。
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly roles: RolesService,
  ) {}

  async summary(userId: string, input: RangeInput) {
    const range = this.resolveRange(input);
    const scope = await this.resolveScope(userId);

    const [currentLogs, pending, decisions, projectCount] = await Promise.all([
      // 工时按"当前版本"统计：退回改版后旧版本仍留在表里（append-only），
      // 直接对 work_log_versions 求和会把同一份工作重复计数。DRAFT 也排除：
      // 还没提交的草稿不算投入工时。
      this.prisma.workLog.findMany({
        where: {
          ...this.logWhereFor(scope),
          status: { not: 'DRAFT' },
          currentVersionId: { not: null },
          // 日期过滤下推到 SQL：不要把作用域内全部历史日志都拉进内存。
          currentVersion: { workDate: { gte: range.fromDate, lt: range.toDateExclusive } },
        },
        select: { currentVersion: { select: { hours: true } } },
        take: REPORT_ROW_LIMIT + 1,
      }),
      this.prisma.approvalRequest.count({
        where: {
          status: 'PENDING',
          workLogVersion: { workLog: { ...this.logWhereFor(scope), status: 'SUBMITTED' } },
        },
      }),
      this.prisma.approvalDecision.groupBy({
        by: ['decision'],
        _count: { _all: true },
        where: {
          decidedAt: { gte: range.fromUtc, lt: range.toUtcExclusive },
          approvalRequest: {
            workLogVersion: { workLog: this.logWhereFor(scope) },
          },
        },
      }),
      this.prisma.project.count({
        where:
          scope.kind === 'PROJECTS'
            ? { id: { in: scope.projectIds }, status: 'ACTIVE', deletedAt: null }
            : {
                status: 'ACTIVE',
                deletedAt: null,
                workLogs: { some: { authorId: userId, deletedAt: null } },
              },
      }),
    ]);

    const hoursTruncated = currentLogs.length > REPORT_ROW_LIMIT;
    const hoursTotal = currentLogs
      .slice(0, REPORT_ROW_LIMIT)
      .reduce((sum, log) => sum + this.toNumber(log.currentVersion?.hours), 0);

    const decided = { approved: 0, returned: 0, rejected: 0 };
    for (const row of decisions) {
      if (row.decision === 'APPROVED') decided.approved = row._count._all;
      if (row.decision === 'RETURNED') decided.returned = row._count._all;
      if (row.decision === 'REJECTED') decided.rejected = row._count._all;
    }
    const decidedTotal = decided.approved + decided.returned + decided.rejected;

    return {
      scope: scope.kind === 'OWN' ? 'OWN' : 'PROJECTS',
      range: {
        from: range.from,
        to: range.to,
        timezone: range.timezone,
      },
      hours: { total: Math.round(hoursTotal * 100) / 100, truncated: hoursTruncated },
      approvals: {
        pending,
        // 待办是"此刻"的快照，不随区间变化；字段名显式说明，避免被误读成区间内新增。
        pendingAsOf: range.to,
        decided,
        // 退回率 = 退回 / 已决策；没有决策时给 0 而不是 NaN。
        returnRate: decidedTotal === 0 ? 0 : decided.returned / decidedTotal,
      },
      projects: { inScope: projectCount },
    };
  }

  async byProject(userId: string, input: RangeInput) {
    const range = this.resolveRange(input);
    const scope = await this.resolveScope(userId);

    const currentLogs = await this.prisma.workLog.findMany({
      where: {
        ...this.logWhereFor(scope),
        status: { not: 'DRAFT' },
        currentVersionId: { not: null },
        currentVersion: { workDate: { gte: range.fromDate, lt: range.toDateExclusive } },
      },
      select: {
        projectId: true,
        project: { select: { id: true, number: true, name: true } },
        currentVersion: { select: { hours: true } },
      },
      // 聚合走内存，用显式上限避免无界加载；触发上限时在返回体里标注。
      take: REPORT_ROW_LIMIT + 1,
    });
    const truncated = currentLogs.length > REPORT_ROW_LIMIT;
    const versions = currentLogs.slice(0, REPORT_ROW_LIMIT);

    const decisions = await this.prisma.approvalDecision.findMany({
      where: {
        decidedAt: { gte: range.fromUtc, lt: range.toUtcExclusive },
        approvalRequest: { workLogVersion: { workLog: this.logWhereFor(scope) } },
      },
      select: {
        decision: true,
        approvalRequest: {
          select: { workLogVersion: { select: { workLog: { select: { projectId: true } } } } },
        },
      },
      // 决策同样设上限，避免无界加载；截断时通过 truncated 告知调用方。
      take: REPORT_ROW_LIMIT + 1,
    });
    const decisionsTruncated = decisions.length > REPORT_ROW_LIMIT;

    const rows = new Map<
      string,
      {
        projectId: string;
        number: string;
        name: string;
        hours: number;
        approved: number;
        returned: number;
        rejected: number;
      }
    >();
    const ensure = (project: { id: string; number: string; name: string } | null, id: string) => {
      const existing = rows.get(id);
      if (existing) return existing;
      const created = {
        projectId: id,
        number: project?.number ?? '—',
        name: project?.name ?? '未关联项目',
        hours: 0,
        approved: 0,
        returned: 0,
        rejected: 0,
      };
      rows.set(id, created);
      return created;
    };

    for (const log of versions) {
      const row = ensure(log.project, log.projectId);
      row.hours += this.toNumber(log.currentVersion?.hours);
    }
    for (const decision of decisions.slice(0, REPORT_ROW_LIMIT)) {
      const projectId = decision.approvalRequest.workLogVersion.workLog.projectId;
      const row = ensure(null, projectId);
      if (decision.decision === 'APPROVED') row.approved += 1;
      if (decision.decision === 'RETURNED') row.returned += 1;
      if (decision.decision === 'REJECTED') row.rejected += 1;
    }

    const items = [...rows.values()]
      .map((row) => {
        const decidedTotal = row.approved + row.returned + row.rejected;
        return {
          ...row,
          hours: Math.round(row.hours * 100) / 100,
          returnRate: decidedTotal === 0 ? 0 : row.returned / decidedTotal,
        };
      })
      .sort((a, b) => b.hours - a.hours || a.number.localeCompare(b.number));

    return {
      range: { from: range.from, to: range.to, timezone: range.timezone },
      items,
      truncated: truncated || decisionsTruncated,
    };
  }

  /** 明细下钻：必须额外持有 `report:drilldown`，且项目在本人的作用域内。 */
  async drilldown(userId: string, projectId: string, input: RangeInput) {
    // 先判能力、再读任何数据：没有下钻能力的人不应该触发一次全项目扫描。
    const permissions = await this.roles.listUserPermissions(userId);
    if (!permissions.includes(PERMISSIONS.REPORT_DRILLDOWN)) {
      throw new ForbiddenException('无权限查看报表明细');
    }
    const range = this.resolveRange(input);
    const scope = await this.resolveScope(userId, permissions);
    if (scope.kind === 'OWN') {
      // 只有自己时也允许下钻，但只返回自己的日志。
      return this.projectWorkLogs({ authorId: userId, projectId }, range);
    }
    if (!scope.projectIds.includes(projectId)) {
      throw new ForbiddenException('无权限查看该项目明细');
    }
    return this.projectWorkLogs({ projectId }, range);
  }

  private async projectWorkLogs(
    filter: { projectId: string; authorId?: string },
    range: ResolvedRange,
  ) {
    const versions = await this.prisma.workLogVersion.findMany({
      where: {
        workDate: { gte: range.fromDate, lt: range.toDateExclusive },
        workLog: {
          projectId: filter.projectId,
          deletedAt: null,
          ...(filter.authorId ? { authorId: filter.authorId } : {}),
        },
      },
      select: {
        versionNumber: true,
        workDate: true,
        hours: true,
        completion: true,
        workLog: {
          select: {
            id: true,
            number: true,
            status: true,
            author: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: [{ workDate: 'desc' }, { versionNumber: 'desc' }, { workLogId: 'asc' }],
      take: DETAIL_ROW_LIMIT + 1,
    });
    const truncated = versions.length > DETAIL_ROW_LIMIT;
    const page = versions.slice(0, DETAIL_ROW_LIMIT);
    return {
      range: { from: range.from, to: range.to, timezone: range.timezone },
      truncated,
      items: page.map((version) => ({
        workLogId: version.workLog.id,
        number: version.workLog.number,
        status: version.workLog.status,
        author: version.workLog.author,
        versionNumber: version.versionNumber,
        workDate: version.workDate,
        hours: this.toNumber(version.hours),
        completion: version.completion,
      })),
    };
  }

  private async resolveScope(userId: string, known?: string[]): Promise<Scope> {
    const permissions = known ?? (await this.roles.listUserPermissions(userId));
    if (!permissions.includes(PERMISSIONS.PROJECT_VIEW)) {
      return { kind: 'OWN', userId };
    }
    const projects = await this.prisma.project.findMany({
      where: { status: 'ACTIVE', deletedAt: null },
      select: { id: true },
    });
    return { kind: 'PROJECTS', projectIds: projects.map((project) => project.id) };
  }

  private logWhereFor(scope: Scope) {
    if (scope.kind === 'OWN') return { authorId: scope.userId, deletedAt: null };
    return { projectId: { in: scope.projectIds }, deletedAt: null };
  }

  private resolveRange(input: RangeInput): ResolvedRange {
    const today = todayInBusinessZone();
    const to = input?.to ?? today;
    // 在"本地日期空间"里减 6 天：按瞬时减 6×24h 会因夏令时偏移落到前一天，变成 8 天窗口。
    const defaultFromDate = new Date(`${today}T00:00:00.000Z`);
    defaultFromDate.setUTCDate(defaultFromDate.getUTCDate() - 6);
    const from = input?.from ?? defaultFromDate.toISOString().slice(0, 10);
    if (!isRealCalendarDate(from) || !isRealCalendarDate(to)) {
      throw new BadRequestException('日期必须是真实存在的 YYYY-MM-DD 日期');
    }
    const fromUtc = zonedDayStartUtc(from);
    const toUtcExclusive = zonedDayEndExclusiveUtc(to);
    if (fromUtc >= toUtcExclusive) throw new BadRequestException('起始日期必须早于结束日期');
    const fromDate = new Date(`${from}T00:00:00.000Z`);
    const toDateExclusive = new Date(`${to}T00:00:00.000Z`);
    toDateExclusive.setUTCDate(toDateExclusive.getUTCDate() + 1);
    return {
      from,
      to,
      fromUtc,
      toUtcExclusive,
      fromDate,
      toDateExclusive,
      timezone: BUSINESS_TIMEZONE,
    };
  }

  private toNumber(value: unknown): number {
    if (value === null || value === undefined) return 0;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : 0;
  }
}
