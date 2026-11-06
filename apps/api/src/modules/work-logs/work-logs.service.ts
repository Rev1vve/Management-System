import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';

import { PrismaService } from '../../database/prisma.service';
import { PERMISSIONS, type PermissionKey } from '../authorization/permission.constants';
import { ProjectAccessService } from '../project-access/project-access.service';
import { RolesService } from '../roles/roles.service';

/**
 * 工作日志（任务 8）。
 *
 * 第一片只覆盖"创建草稿"：日志与第一个版本在同一事务内落库，
 * `currentVersionId` 在创建瞬间就指向该版本，避免出现无当前版本的悬挂草稿。
 *
 * 边界（主计划 §4.2）：
 *  - 只有项目成员可在项目内创建；非成员与不存在项目同为 404（防枚举）。
 *  - 草稿默认 PRIVATE；写可见性需要项目内 PROJECT_MANAGER 或 worklog:manage 能力。
 *  - 提交/审批/退回后新版本属于后续切片，本片不实现状态迁移。
 */

export interface SubmitWorkLogInput {
  approverId: string;
}

const SUBMIT_BLOCKED_MESSAGE = '当前状态不可提交：退回修改必须以新草稿版本重新提交';

const CREATE_FIELDS = new Set([
  'projectId',
  'workDate',
  'hours',
  'completion',
  'progressNote',
  'orderId',
  'orderItemId',
  'visibility',
]);

const VISIBILITIES = new Set(['PRIVATE', 'PROJECT_VISIBLE']);
const WORK_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_HOURS = 24;
const MAX_TEXT = 5000;

export interface CreateWorkLogInput {
  projectId: string;
  workDate: string;
  hours: number;
  completion: string;
  progressNote?: string | null;
  orderId?: string | null;
  orderItemId?: string | null;
  visibility?: string;
}

interface ParsedDraft {
  projectId: string;
  workDate: Date;
  hours: string;
  completion: string;
  progressNote: string | null;
  orderId: string | null;
  orderItemId: string | null;
  visibility: 'PRIVATE' | 'PROJECT_VISIBLE';
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BadRequestException(`${field} 必须是非空字符串`);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new BadRequestException(`${field} 必须是字符串`);
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_TEXT) throw new BadRequestException(`${field} 长度超出限制`);
  return trimmed;
}

function parseWorkDate(value: unknown): Date {
  const text = requireString(value, 'workDate');
  if (!WORK_DATE_PATTERN.test(text)) throw new BadRequestException('workDate 必须是 YYYY-MM-DD');
  const parsed = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) throw new BadRequestException('workDate 不是有效日期');
  // 拒绝 2026-02-31 这类被 Date 归一化的日期。
  if (parsed.toISOString().slice(0, 10) !== text) {
    throw new BadRequestException('workDate 不是有效日期');
  }
  return parsed;
}

function parseHours(value: unknown): string {
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw new BadRequestException('hours 必须是数字');
  }
  const text = typeof value === 'string' ? value.trim() : String(value);
  // 用字符串判定小数位：浮点乘法会把 1.15/2.55/4.35/0.07 判成三位小数而误拒。
  if (!/^\d+(?:\.\d+)?$/.test(text)) throw new BadRequestException('hours 必须是数字');
  const fraction = text.includes('.') ? text.split('.')[1]! : '';
  if (fraction.length > 2) throw new BadRequestException('hours 最多两位小数');
  const numeric = Number(text);
  if (!Number.isFinite(numeric)) throw new BadRequestException('hours 必须是数字');
  if (numeric <= 0 || numeric > MAX_HOURS) {
    throw new BadRequestException(`hours 必须大于 0 且不超过 ${MAX_HOURS}`);
  }
  return numeric.toFixed(2);
}

function parseDraft(input: CreateWorkLogInput): ParsedDraft {
  const unknown = Object.keys(input ?? {}).filter((key) => !CREATE_FIELDS.has(key));
  if (unknown.length > 0) throw new BadRequestException(`不支持的字段：${unknown.join(', ')}`);

  const visibilityValue = input.visibility ?? 'PRIVATE';
  if (typeof visibilityValue !== 'string' || !VISIBILITIES.has(visibilityValue)) {
    throw new BadRequestException('visibility 非法');
  }

  const completion = requireString(input.completion, 'completion');
  if (completion.length > MAX_TEXT) throw new BadRequestException('completion 长度超出限制');

  return {
    projectId: requireString(input.projectId, 'projectId'),
    workDate: parseWorkDate(input.workDate),
    hours: parseHours(input.hours),
    completion,
    progressNote: optionalString(input.progressNote, 'progressNote'),
    orderId: optionalString(input.orderId, 'orderId'),
    orderItemId: optionalString(input.orderItemId, 'orderItemId'),
    visibility: visibilityValue as 'PRIVATE' | 'PROJECT_VISIBLE',
  };
}

const VERSION_FIELDS = new Set([
  'workDate',
  'hours',
  'completion',
  'progressNote',
  'orderId',
  'orderItemId',
]);

export interface VersionContentInput {
  workDate: string;
  hours: number;
  completion: string;
  progressNote?: string | null;
  orderId?: string | null;
  orderItemId?: string | null;
}

interface ParsedVersionContent {
  workDate: Date;
  hours: string;
  completion: string;
  progressNote: string | null;
  orderId: string | null;
  orderItemId: string | null;
}

function parseVersionContent(input: VersionContentInput): ParsedVersionContent {
  const unknown = Object.keys(input ?? {}).filter((key) => !VERSION_FIELDS.has(key));
  if (unknown.length > 0) throw new BadRequestException(`不支持的字段：${unknown.join(', ')}`);
  const completion = requireString(input.completion, 'completion');
  if (completion.length > MAX_TEXT) throw new BadRequestException('completion 长度超出限制');
  return {
    workDate: parseWorkDate(input.workDate),
    hours: parseHours(input.hours),
    completion,
    progressNote: optionalString(input.progressNote, 'progressNote'),
    orderId: optionalString(input.orderId, 'orderId'),
    orderItemId: optionalString(input.orderItemId, 'orderItemId'),
  };
}

function parseExpectedVersion(value: unknown): number {
  const numeric = typeof value === 'string' ? Number(value) : value;
  if (typeof numeric !== 'number' || !Number.isInteger(numeric) || numeric < 1) {
    throw new BadRequestException('version 必须是大于 0 的整数');
  }
  return numeric;
}

function workLogNumber(workDate: Date): string {
  const stamp = workDate.toISOString().slice(0, 10).replace(/-/g, '');
  return `WL-${stamp}-${randomBytes(4).toString('hex').toUpperCase()}`;
}

@Injectable()
export class WorkLogsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projectAccess: ProjectAccessService,
    private readonly roles: RolesService,
  ) {}

  async createDraft(userId: string, input: CreateWorkLogInput) {
    // 先鉴权、再暴露字段/格式校验细节：非成员不应通过 400/404 的差异探测字段白名单。
    const projectId = requireString(input?.projectId, 'projectId');
    const { roles } = await this.projectAccess.assertProjectAccess(userId, projectId);
    const draft = parseDraft(input);
    if (draft.visibility === 'PROJECT_VISIBLE') {
      const permissions: PermissionKey[] = await this.roles.listUserPermissions(userId);
      const mayManage =
        roles.includes('PROJECT_MANAGER') || permissions.includes(PERMISSIONS.WORKLOG_MANAGE);
      if (!mayManage) throw new ForbiddenException('无权限设置工作日志可见性');
    }

    // 有界重试：编号随机后缀冲突时换号，最多 3 次；其它错误立即失败关闭。
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.prisma.$transaction(async (tx) => {
          await this.assertOrderScope(tx, draft.projectId, draft.orderId, draft.orderItemId);

          const workLog = await tx.workLog.create({
            data: {
              number: workLogNumber(draft.workDate),
              authorId: userId,
              projectId: draft.projectId,
              orderId: draft.orderId,
              orderItemId: draft.orderItemId,
              status: 'DRAFT',
              visibility: draft.visibility,
            },
            select: { id: true, number: true },
          });
          const version = await tx.workLogVersion.create({
            data: {
              workLogId: workLog.id,
              versionNumber: 1,
              workDate: draft.workDate,
              hours: draft.hours,
              completion: draft.completion,
              progressNote: draft.progressNote,
              submittedById: userId,
            },
            select: { id: true, versionNumber: true },
          });
          await tx.workLog.update({
            where: { id: workLog.id },
            data: { currentVersionId: version.id },
          });
          // 返回 workLog.version 作为乐观并发令牌：后续 PATCH 必须带它。
          return {
            id: workLog.id,
            number: workLog.number,
            versionNumber: version.versionNumber,
            version: 1,
          };
        });
      } catch (error) {
        const code =
          typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
        // 业务编号随机后缀冲突：换号重试；其它错误立即失败关闭。
        if (code !== 'P2002' || attempt >= 2) throw error;
      }
    }
  }

  /**
   * 退回后开新版本：仅作者本人、仅 RETURNED。
   *
   * 事务内取当前最大 versionNumber 再 +1；旧的 WorkLogVersion 与其审批历史一行不改，
   * currentVersionId 指向新版本、状态回 DRAFT，用 CAS（status + currentVersionId）防并发。
   */
  async addVersion(userId: string, workLogId: string, input: VersionContentInput) {
    // 先鉴权再暴露校验细节：任何调用方对"别人的/不存在的日志"都应拿到同一个 404。
    const log = await this.loadOwnedLog(userId, workLogId);
    if (log.status !== 'RETURNED') {
      throw new ConflictException('仅退回修改的工作日志可以创建新版本');
    }
    const content = parseVersionContent(input);

    try {
      return await this.prisma.$transaction(
        async (tx) => {
          await this.assertAuthorMembership(tx, userId, log.projectId);
          await this.assertOrderScope(tx, log.projectId, content.orderId, content.orderItemId);

          const aggregate = await tx.workLogVersion.aggregate({
            where: { workLogId: log.id },
            _max: { versionNumber: true },
          });
          const versionNumber = (aggregate._max.versionNumber ?? 0) + 1;
          const version = await tx.workLogVersion.create({
            data: {
              workLogId: log.id,
              versionNumber,
              workDate: content.workDate,
              hours: content.hours,
              completion: content.completion,
              progressNote: content.progressNote,
              submittedById: userId,
            },
            select: { id: true, versionNumber: true },
          });

          const before = await tx.workLog.findUniqueOrThrow({
            where: { id: log.id },
            select: { version: true },
          });
          const updated = await tx.workLog.updateMany({
            where: {
              id: log.id,
              authorId: userId,
              status: 'RETURNED',
              currentVersionId: log.currentVersionId,
              deletedAt: null,
            },
            data: {
              status: 'DRAFT',
              currentVersionId: version.id,
              version: { increment: 1 },
              // 订单引用写入 WorkLog 本身：此前只校验不落库，接口契约与实现不一致。
              // 只给 orderId 时把旧的 orderItemId 清空，避免留下跨订单的不一致引用。
              ...(content.orderId === null
                ? {}
                : { orderId: content.orderId, orderItemId: content.orderItemId }),
            },
          });
          if (updated.count !== 1) throw new ConflictException('工作日志状态已变化，请刷新后重试');

          return {
            id: log.id,
            status: 'DRAFT' as const,
            versionNumber: version.versionNumber,
            version: before.version + 1,
          };
        },
        // 两个并发 addVersion 会同时读到同一个 max，靠串行化/唯一约束兜底；
        // 冲突必须映射成 409，而不是把 P2002/P2034 漏成 500。
        { isolationLevel: 'Serializable' },
      );
    } catch (error) {
      if (this.isConcurrencyError(error)) {
        throw new ConflictException('工作日志状态已变化，请刷新后重试');
      }
      throw error;
    }
  }

  /**
   * 编辑草稿当前版本：仅作者本人、仅 DRAFT。
   *
   * 已提交/已通过/已退回/已拒绝一律 409——退回必须走 addVersion 生成新版本，历史不被覆盖。
   */
  async updateDraft(
    userId: string,
    workLogId: string,
    input: VersionContentInput,
    expectedVersion: unknown,
  ) {
    const log = await this.loadOwnedLog(userId, workLogId);
    if (log.status !== 'DRAFT') throw new ConflictException('只有草稿可以编辑');
    if (!log.currentVersionId) throw new ConflictException('工作日志缺少当前版本');
    const content = parseVersionContent(input);
    const version = parseExpectedVersion(expectedVersion);

    return this.prisma.$transaction(async (tx) => {
      await this.assertAuthorMembership(tx, userId, log.projectId);
      await this.assertOrderScope(tx, log.projectId, content.orderId, content.orderItemId);

      // 乐观并发：必须比对调用方持有的 version。此前的谓词只有 status + currentVersionId，
      // 编辑动作不改变这两者，谓词恒真 → 并发编辑互相覆盖且都返回成功。
      const cas = await tx.workLog.updateMany({
        where: {
          id: log.id,
          authorId: userId,
          status: 'DRAFT',
          currentVersionId: log.currentVersionId,
          version,
          deletedAt: null,
        },
        data: {
          version: { increment: 1 },
          ...(content.orderId === null
            ? {}
            : { orderId: content.orderId, orderItemId: content.orderItemId }),
        },
      });
      if (cas.count !== 1) throw new ConflictException('工作日志已被修改，请刷新后重试');

      const written = await tx.workLogVersion.updateMany({
        where: { id: log.currentVersionId!, workLogId: log.id },
        data: {
          workDate: content.workDate,
          hours: content.hours,
          completion: content.completion,
          progressNote: content.progressNote,
        },
      });
      if (written.count !== 1) throw new ConflictException('工作日志状态已变化，请刷新后重试');

      return { id: log.id, status: 'DRAFT' as const, version: version + 1 };
    });
  }

  /**
   * 日志详情（仅作者本人）：返回乐观并发令牌 `version` 与当前版本内容。
   * 他人一律 404，与列表/编辑口径一致。
   */
  async getDetail(userId: string, workLogId: string) {
    const log = await this.loadOwnedLog(userId, workLogId);
    return this.prisma.workLog.findFirstOrThrow({
      where: { id: log.id, authorId: userId, deletedAt: null },
      select: {
        id: true,
        number: true,
        status: true,
        visibility: true,
        version: true,
        projectId: true,
        currentVersion: {
          select: {
            id: true,
            versionNumber: true,
            workDate: true,
            hours: true,
            completion: true,
            progressNote: true,
            submittedAt: true,
          },
        },
        versions: {
          select: { id: true, versionNumber: true, submittedAt: true },
          orderBy: { versionNumber: 'asc' },
        },
      },
    });
  }

  private isConcurrencyError(error: unknown): boolean {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: unknown }).code)
        : '';
    // P2002 唯一约束冲突（并发插入同一 versionNumber）、P2034 串行化写冲突。
    return code === 'P2002' || code === 'P2034';
  }

  private async loadOwnedLog(userId: string, workLogId: string) {
    const id = requireString(workLogId, 'workLogId');
    const log = await this.prisma.workLog.findFirst({
      where: { id, authorId: userId, deletedAt: null },
      select: { id: true, status: true, projectId: true, currentVersionId: true },
    });
    // 他人的日志与不存在的日志同一响应，避免探测存在性。
    if (!log) throw new NotFoundException('工作日志不存在');
    return log;
  }

  private async assertAuthorMembership(
    tx: Pick<PrismaService, 'projectMembership'>,
    userId: string,
    projectId: string,
  ): Promise<void> {
    const membership = await tx.projectMembership.findFirst({
      where: {
        userId,
        projectId,
        project: { status: { not: 'ARCHIVED' }, deletedAt: null },
        user: { status: 'ACTIVE', deletedAt: null },
      },
      select: { id: true },
    });
    if (!membership) throw new NotFoundException('工作日志不存在');
  }

  private async assertOrderScope(
    tx: Pick<PrismaService, 'order' | 'orderItem'>,
    projectId: string,
    orderId: string | null,
    orderItemId: string | null,
  ): Promise<void> {
    // 订单引用必须属于已鉴权的项目，否则项目 A 的成员可把日志挂到项目 B 的订单上；
    // 非法引用按 400 拒绝，而不是落到外键错误（500）。
    if (orderItemId && !orderId) {
      throw new BadRequestException('orderItemId 必须与 orderId 同时提供');
    }
    if (orderId) {
      const order = await tx.order.findFirst({
        where: { id: orderId, projectId, deletedAt: null, status: { not: 'ARCHIVED' } },
        select: { id: true },
      });
      if (!order) throw new BadRequestException('订单不属于该项目或已归档');
    }
    if (orderItemId) {
      const item = await tx.orderItem.findFirst({
        where: { id: orderItemId, orderId: orderId! },
        select: { id: true },
      });
      if (!item) throw new BadRequestException('订单明细不属于该订单');
    }
  }

  /**
   * 提交冻结：把当前版本交给指定审批人。
   *
   * - 只有作者本人可提交，其余一律 404（不泄露存在性）。
   * - 仅 DRAFT 可提交；RETURNED 等状态必须走新草稿版本，返回 409。
   * - 状态迁移用 CAS（status + currentVersionId），并发重复提交只有一个成功。
   * - 审批请求与状态迁移在同一事务内产生，禁止自审。
   */
  async submit(userId: string, workLogId: string, input: SubmitWorkLogInput) {
    if (!input || typeof input.approverId !== 'string' || input.approverId.trim().length === 0) {
      throw new BadRequestException('approverId 必须是非空字符串');
    }
    const approverId = input.approverId.trim();
    if (approverId === userId) throw new BadRequestException('不能指定自己为审批人');

    const workLogIdValue = requireString(workLogId, 'workLogId');
    const log = await this.prisma.workLog.findFirst({
      where: { id: workLogIdValue, authorId: userId, deletedAt: null },
      select: { id: true, status: true, projectId: true, currentVersionId: true },
    });
    if (!log) throw new NotFoundException('工作日志不存在');
    if (log.status !== 'DRAFT') throw new ConflictException(SUBMIT_BLOCKED_MESSAGE);
    if (!log.currentVersionId) throw new ConflictException('工作日志缺少当前版本');

    return this.prisma.$transaction(async (tx) => {
      // 审批人资格与状态迁移在同一事务内判定：避免"校验通过后审批人被移出项目"的窗口，
      // 并与 assertProjectAccess 保持同一防枚举口径（404 而非 400）。
      const approverMembership = await tx.projectMembership.findFirst({
        where: {
          userId: approverId,
          projectId: log.projectId,
          project: { status: { not: 'ARCHIVED' }, deletedAt: null },
          user: { status: 'ACTIVE', deletedAt: null },
        },
        select: { id: true },
      });
      if (!approverMembership) throw new NotFoundException('审批人不存在或不是项目当前成员');

      // 作者必须在提交时仍是该项目有效成员：被移出项目后不得继续提交草稿。
      const authorMembership = await tx.projectMembership.findFirst({
        where: {
          userId,
          projectId: log.projectId,
          project: { status: { not: 'ARCHIVED' }, deletedAt: null },
          user: { status: 'ACTIVE', deletedAt: null },
        },
        select: { id: true },
      });
      if (!authorMembership) throw new NotFoundException('工作日志不存在');

      const updated = await tx.workLog.updateMany({
        where: {
          id: log.id,
          authorId: userId,
          status: 'DRAFT',
          currentVersionId: log.currentVersionId,
          deletedAt: null,
        },
        data: { status: 'SUBMITTED', version: { increment: 1 } },
      });
      if (updated.count !== 1) throw new ConflictException(SUBMIT_BLOCKED_MESSAGE);

      // 冻结当前版本：提交之后该版本行永久只读（数据库触发器只看本行 frozen_at）。
      await tx.workLogVersion.updateMany({
        where: { id: log.currentVersionId!, workLogId: log.id, frozenAt: null },
        data: { frozenAt: new Date() },
      });

      const request = await tx.approvalRequest.create({
        data: {
          workLogVersionId: log.currentVersionId!,
          approverId,
          submitterId: userId,
          status: 'PENDING',
        },
        select: { id: true },
      });

      return { id: log.id, status: 'SUBMITTED' as const, approvalRequestId: request.id };
    });
  }
}
