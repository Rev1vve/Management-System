import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';

import { PrismaService } from '../../database/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import { PERMISSIONS } from '../authorization/permission.constants';
import { RolesService } from '../roles/roles.service';
import {
  BUSINESS_TIMEZONE,
  assertCalendarDate,
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
        select: { projectId: true, currentVersion: { select: { hours: true } } },
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
            ? { id: { in: scope.projectIds }, status: { not: 'ARCHIVED' }, deletedAt: null }
            : {
                status: { not: 'ARCHIVED' },
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
      hours: {
        total: Math.round(hoursTotal * 100) / 100,
        truncated: hoursTruncated,
        // 明确是"行数上限"导致偏低，而不是业务上没有工时。
        truncatedReason: hoursTruncated ? 'ROW_LIMIT' : null,
        limit: REPORT_ROW_LIMIT,
      },
      approvals: {
        pending,
        // 待办是"此刻"的快照，不随区间变化：用真实业务日，而不是区间结束日，
        // 否则查历史区间时会把实时数字标成过去的日期。
        pendingAsOf: todayInBusinessZone(),
        decided,
        // 退回率 = 退回 / 已决策；没有决策时给 0 而不是 NaN。
        returnRate: decidedTotal === 0 ? 0 : decided.returned / decidedTotal,
      },
      projects: {
        // 作用域里的项目总数（与区间无关）。
        inScope: projectCount,
        // 区间内真的有工时/决策的项目数——与 byProject 的行数可对账。
        withActivity: new Set(
          currentLogs.map((log) => (log as { projectId?: string }).projectId ?? ''),
        ).size,
      },
    };
  }

  async byProject(userId: string, input: RangeInput) {
    const range = this.resolveRange(input);
    const scope = await this.resolveScope(userId);
    return this.aggregateProjects(range, this.logWhereFor(scope));
  }

  /**
   * 我管理的项目：只看调用者以 PROJECT_MANAGER 身份参与的项目。
   * 这里不做"能力推断"——项目:manage 是能力，管理关系才是事实。
   */
  async managedProjects(userId: string, input: RangeInput) {
    const range = this.resolveRange(input);
    const memberships = await this.prisma.projectMembership.findMany({
      where: {
        userId,
        user: { status: 'ACTIVE', deletedAt: null },
        project: { status: { not: 'ARCHIVED' }, deletedAt: null },
        roles: { some: { role: 'PROJECT_MANAGER' } },
      },
      select: { projectId: true },
    });
    const projectIds = memberships.map((membership) => membership.projectId);
    if (projectIds.length === 0) {
      return {
        range: { from: range.from, to: range.to, timezone: range.timezone },
        items: [],
        projectsManaged: 0,
        truncated: false,
        truncatedReasons: [],
        limit: REPORT_ROW_LIMIT,
      };
    }
    const result = await this.aggregateProjects(range, {
      projectId: { in: projectIds },
      deletedAt: null,
    });
    // 清单以"我管理的项目"为准：区间内没有活动也要出现在列表里（数字为 0），
    // 否则周初的默认 7 天窗口会让页面看起来"我什么都不管理"。
    const projects = await this.prisma.project.findMany({
      where: { id: { in: projectIds }, deletedAt: null },
      select: { id: true, number: true, name: true, status: true, completionPercent: true },
      orderBy: { number: 'asc' },
    });
    const aggregated = new Map(result.items.map((row) => [row.projectId, row]));
    const items = projects.map((project) => {
      const row = aggregated.get(project.id);
      return {
        projectId: project.id,
        number: project.number,
        name: project.name,
        hours: row?.hours ?? 0,
        approved: row?.approved ?? 0,
        returned: row?.returned ?? 0,
        rejected: row?.rejected ?? 0,
        returnRate: row?.returnRate ?? 0,
        status: project.status,
        completionPercent: project.completionPercent,
      };
    });
    return {
      range: { from: range.from, to: range.to, timezone: range.timezone },
      items,
      projectsManaged: projects.length,
      truncated: result.truncated,
      truncatedReasons: result.truncatedReasons,
      limit: result.limit,
    };
  }

  /**
   * 项目集视角：只统计调用者**属于**的项目集（PortfolioMembership 是事实，
   * `portfolio:view` 只是能力）。没有任何项目集归属时返回空集，而不是全部。
   */
  async portfolios(userId: string, input: RangeInput) {
    const range = this.resolveRange(input);
    // 归属总数（含已归档的项目集）用于区分"没有归属"与"归属的集都归档了"。
    const permissions = await this.roles.listUserPermissions(userId);
    const viewAll = permissions.includes(PERMISSIONS.REPORT_VIEW_ALL);

    // 有全局聚合能力的人（高层）在所有项目集上汇总；其他人只看自己所属的项目集。
    const allMemberships = viewAll
      ? await this.prisma.portfolio.count({
          where: { status: { not: 'ARCHIVED' }, deletedAt: null },
        })
      : await this.prisma.portfolioMembership.count({
          where: { userId, user: { status: 'ACTIVE', deletedAt: null } },
        });
    if (viewAll) {
      const allPortfolios = await this.prisma.portfolio.findMany({
        where: { status: { not: 'ARCHIVED' }, deletedAt: null },
        select: { id: true, name: true },
      });
      return this.aggregatePortfolios(range, allPortfolios, allMemberships);
    }
    const memberships = await this.prisma.portfolioMembership.findMany({
      where: {
        userId,
        user: { status: 'ACTIVE', deletedAt: null },
        // 与项目集列表同一口径：归档/软删的项目集不再统计。
        portfolio: { status: { not: 'ARCHIVED' }, deletedAt: null },
      },
      select: { portfolioId: true, portfolio: { select: { id: true, name: true } } },
    });
    return this.aggregatePortfolios(
      range,
      memberships.map((membership) => membership.portfolio),
      allMemberships,
    );
  }

  private async aggregatePortfolios(
    range: ResolvedRange,
    portfolios: Array<{ id: string; name: string }>,
    portfoliosTotal: number,
  ) {
    if (portfolios.length === 0) {
      return {
        range: { from: range.from, to: range.to, timezone: range.timezone },
        items: [],
        portfoliosTotal,
        truncated: false,
        truncatedReasons: [],
        limit: REPORT_ROW_LIMIT,
      };
    }
    const names = new Map(portfolios.map((portfolio) => [portfolio.id, portfolio.name]));
    const projects = await this.prisma.project.findMany({
      where: {
        portfolioId: { in: portfolios.map((portfolio) => portfolio.id) },
        status: { not: 'ARCHIVED' },
        deletedAt: null,
      },
      select: { id: true, portfolioId: true },
    });
    if (projects.length === 0) {
      return {
        range: { from: range.from, to: range.to, timezone: range.timezone },
        items: [],
        portfoliosTotal,
        truncated: false,
        truncatedReasons: [],
        limit: REPORT_ROW_LIMIT,
      };
    }
    const projectToPortfolio = new Map(
      projects.map((project) => [project.id, project.portfolioId ?? '']),
    );
    const result = await this.aggregateProjects(range, {
      projectId: { in: projects.map((project) => project.id) },
      deletedAt: null,
    });
    const grouped = new Map<
      string,
      {
        portfolioId: string;
        name: string;
        projects: number;
        hours: number;
        approved: number;
        returned: number;
        rejected: number;
      }
    >();
    for (const project of projects) {
      const portfolioId = project.portfolioId ?? '';
      const existing = grouped.get(portfolioId);
      if (existing) {
        existing.projects += 1;
        continue;
      }
      grouped.set(portfolioId, {
        portfolioId,
        name: names.get(portfolioId) ?? '未命名项目集',
        projects: 1,
        hours: 0,
        approved: 0,
        returned: 0,
        rejected: 0,
      });
    }
    for (const row of result.items) {
      const portfolioId = projectToPortfolio.get(row.projectId);
      if (!portfolioId) continue;
      const target = grouped.get(portfolioId);
      if (!target) continue;
      target.hours += row.hours;
      target.approved += row.approved;
      target.returned += row.returned;
      target.rejected += row.rejected;
    }
    const items = [...grouped.values()]
      .map((row) => {
        const decidedTotal = row.approved + row.returned + row.rejected;
        return {
          ...row,
          hours: Math.round(row.hours * 100) / 100,
          returnRate: decidedTotal === 0 ? 0 : row.returned / decidedTotal,
        };
      })
      .sort((a, b) => b.hours - a.hours || a.name.localeCompare(b.name));
    return {
      range: { from: range.from, to: range.to, timezone: range.timezone },
      items,
      portfoliosTotal,
      truncated: result.truncated,
      truncatedReasons: result.truncatedReasons,
      limit: result.limit,
    };
  }

  private async aggregateProjects(range: ResolvedRange, logWhere: Record<string, unknown>) {
    const currentLogs = await this.prisma.workLog.findMany({
      where: {
        ...logWhere,
        status: { not: 'DRAFT' },
        currentVersionId: { not: null },
        currentVersion: { workDate: { gte: range.fromDate, lt: range.toDateExclusive } },
      },
      select: {
        projectId: true,
        project: { select: { id: true, number: true, name: true } },
        currentVersion: { select: { hours: true } },
      },
      take: REPORT_ROW_LIMIT + 1,
    });
    const truncated = currentLogs.length > REPORT_ROW_LIMIT;
    const versions = currentLogs.slice(0, REPORT_ROW_LIMIT);

    const decisions = await this.prisma.approvalDecision.findMany({
      where: {
        decidedAt: { gte: range.fromUtc, lt: range.toUtcExclusive },
        approvalRequest: { workLogVersion: { workLog: logWhere } },
      },
      select: {
        decision: true,
        approvalRequest: {
          select: { workLogVersion: { select: { workLog: { select: { projectId: true } } } } },
        },
      },
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
      truncatedReasons: [
        ...(truncated ? ['WORK_LOG_ROW_LIMIT'] : []),
        ...(decisionsTruncated ? ['DECISION_ROW_LIMIT'] : []),
      ],
      limit: REPORT_ROW_LIMIT,
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
          project: { status: { not: 'ARCHIVED' }, deletedAt: null },
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
      limit: DETAIL_ROW_LIMIT,
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

  /**
   * 作用域（用户 2026-11-08 决定，方案 A）：
   *  - 没有 `project:view` → 只看自己；
   *  - 持 EXECUTIVE 系统角色 → 全部非归档项目的聚合（下钻仍需 `report:drilldown`）；
   *  - 否则若属于某些项目集 → 这些项目集内的项目（项目总监口径）；
   *  - 否则按项目成员关系 → 自己参与的项目（项目经理/审批人/观察者）；
   *  - 都没有 → 退回"只看自己"。
   * 任何分支都不包含 ARCHIVED 或软删项目，保证各报表能对上账。
   */
  private async resolveScope(userId: string, known?: string[]): Promise<Scope> {
    const permissions = known ?? (await this.roles.listUserPermissions(userId));
    if (!permissions.includes(PERMISSIONS.PROJECT_VIEW)) {
      return { kind: 'OWN', userId };
    }

    const baseWhere = { status: { not: 'ARCHIVED' as const }, deletedAt: null };

    // 用能力而不是角色名判定：角色 key 是可变的字符串，权限才是受审计的授权轴。
    if (permissions.includes(PERMISSIONS.REPORT_VIEW_ALL)) {
      const projects = await this.prisma.project.findMany({
        where: baseWhere,
        select: { id: true },
      });
      return { kind: 'PROJECTS', projectIds: projects.map((project) => project.id) };
    }

    const portfolios = await this.prisma.portfolioMembership.findMany({
      where: {
        userId,
        user: { status: 'ACTIVE', deletedAt: null },
        portfolio: { status: { not: 'ARCHIVED' }, deletedAt: null },
      },
      select: { portfolioId: true },
    });
    if (portfolios.length > 0) {
      const projects = await this.prisma.project.findMany({
        where: { ...baseWhere, portfolioId: { in: portfolios.map((row) => row.portfolioId) } },
        select: { id: true },
      });
      // 项目集存在但没有在建项目时继续往下走，避免"明明在管项目却报表全空"。
      if (projects.length > 0) {
        return { kind: 'PROJECTS', projectIds: projects.map((project) => project.id) };
      }
    }

    const memberships = await this.prisma.projectMembership.findMany({
      where: {
        userId,
        user: { status: 'ACTIVE', deletedAt: null },
        project: baseWhere,
      },
      select: { projectId: true },
    });
    if (memberships.length > 0) {
      return { kind: 'PROJECTS', projectIds: memberships.map((row) => row.projectId) };
    }

    return { kind: 'OWN', userId };
  }

  private logWhereFor(scope: Scope): Prisma.WorkLogWhereInput {
    // 两个分支都必须排除归档/软删项目，否则"员工视角"会看到已归档项目的工时，
    // 与 project:view 视角对不上账。
    if (scope.kind === 'OWN') {
      return {
        authorId: scope.userId,
        deletedAt: null,
        project: { status: { not: 'ARCHIVED' as const }, deletedAt: null },
      };
    }
    return {
      projectId: { in: scope.projectIds },
      deletedAt: null,
      project: { status: { not: 'ARCHIVED' as const }, deletedAt: null },
    };
  }

  private resolveRange(input: RangeInput): ResolvedRange {
    const today = todayInBusinessZone();
    const to = input?.to ?? today;
    // 在"本地日期空间"里减 6 天：按瞬时减 6×24h 会因夏令时偏移落到前一天，变成 8 天窗口。
    const defaultFromDate = new Date(`${today}T00:00:00.000Z`);
    defaultFromDate.setUTCDate(defaultFromDate.getUTCDate() - 6);
    const from = input?.from ?? defaultFromDate.toISOString().slice(0, 10);
    assertCalendarDate(from);
    assertCalendarDate(to);
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
