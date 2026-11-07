import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from '../../database/prisma.service';
import { PERMISSIONS } from '../authorization/permission.constants';
import { ProjectAccessService } from '../project-access/project-access.service';
import { RolesService } from '../roles/roles.service';

const DECISIONS = new Set(['APPROVED', 'RETURNED', 'REJECTED']);
const WORK_LOG_STATUS_BY_DECISION = {
  APPROVED: 'APPROVED',
  RETURNED: 'RETURNED',
  REJECTED: 'REJECTED',
} as const;

interface DecideInput {
  decision: string;
  comment?: string | null;
}

/**
 * 单级审批（任务 9）。
 *
 * 三重校验缺一不可：
 *  1. 只有被指定的审批人本人可以决策；
 *  2. 审批请求仍是 PENDING（禁止重复/并发审批）；
 *  3. 日志仍处于 SUBMITTED，且 **currentVersionId 正好是本请求绑定的版本**
 *     —— 这一条是 review-12 遗留"版本重指向"风险的自然归宿：没有它，
 *     一份指向旧版本的审批请求可以在新版本上被通过。
 */
@Injectable()
export class ApprovalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projectAccess: ProjectAccessService,
    private readonly roles: RolesService,
  ) {}

  async listPending(userId: string, query: { page?: number; pageSize?: number }) {
    const rawPage = Number(query?.page ?? 1);
    const page = Number.isSafeInteger(rawPage) && rawPage >= 1 ? rawPage : 1;
    const rawPageSize = Number(query?.pageSize ?? 20);
    const pageSize =
      Number.isSafeInteger(rawPageSize) && rawPageSize >= 1 ? Math.min(100, rawPageSize) : 20;

    // 撤权后连"可读"也要收回：只在本人仍是有效成员、且有审批资格的项目里列待办。
    const projectIds = await this.eligibleProjectIds(userId);
    if (projectIds.length === 0) return { items: [], page, pageSize, total: 0 };

    const where = {
      approverId: userId,
      status: 'PENDING' as const,
      // 日志已离开 SUBMITTED 的请求永远无法处理，不该继续占着待办列表。
      workLogVersion: {
        workLog: {
          status: 'SUBMITTED' as const,
          deletedAt: null,
          projectId: { in: projectIds },
        },
      },
    };
    const [items, total] = await Promise.all([
      this.prisma.approvalRequest.findMany({
        where,
        select: {
          id: true,
          submittedAt: true,
          workLogVersion: {
            select: {
              id: true,
              versionNumber: true,
              workDate: true,
              hours: true,
              completion: true,
              workLog: {
                select: {
                  id: true,
                  number: true,
                  currentVersionId: true,
                  project: { select: { id: true, number: true, name: true } },
                  author: { select: { id: true, name: true } },
                },
              },
            },
          },
        },
        orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.approvalRequest.count({ where }),
    ]);
    // 版本已被替换的请求仍在列表里，但标记为不可决策，避免用户点了才 409。
    const decorated = items.map((item) => ({
      ...item,
      canDecide: item.workLogVersion.workLog.currentVersionId === item.workLogVersion.id,
    }));
    return { items: decorated, page, pageSize, total };
  }

  /** 本人仍有审批资格的项目集合（有效成员 + APPROVER 角色，或持有 approval:decide）。 */
  private async eligibleProjectIds(userId: string): Promise<string[]> {
    const memberships = await this.prisma.projectMembership.findMany({
      where: {
        userId,
        user: { status: 'ACTIVE', deletedAt: null },
        // 与 assertProjectAccess 同一口径：只排除归档/软删项目，
        // DRAFT/ON_HOLD/COMPLETED 的项目仍可审批（收窄成 ACTIVE 会让合法待办消失）。
        project: { status: { not: 'ARCHIVED' }, deletedAt: null },
      },
      select: { projectId: true, roles: { select: { role: true } } },
    });
    if (memberships.length === 0) return [];
    const permissions = await this.roles.listUserPermissions(userId);
    const hasCapability = permissions.includes(PERMISSIONS.APPROVAL_DECIDE);
    return memberships
      .filter(
        (membership) =>
          hasCapability || membership.roles.some((entry) => entry.role === 'APPROVER'),
      )
      .map((membership) => membership.projectId);
  }

  /** 与 submit 同一口径：仍是该项目有效成员，且持 APPROVER 角色或 approval:decide 能力。 */
  private async assertStillEligibleApprover(
    userId: string,
    projectId: string,
  ): Promise<{ hasCapability: boolean }> {
    const { roles } = await this.projectAccess.assertProjectAccess(userId, projectId);
    if (roles.includes('APPROVER')) return { hasCapability: false };
    const permissions = await this.roles.listUserPermissions(userId);
    const hasCapability = permissions.includes(PERMISSIONS.APPROVAL_DECIDE);
    if (!hasCapability) throw new ForbiddenException('你已不是该项目的审批人');
    return { hasCapability };
  }

  async decide(userId: string, approvalRequestId: string, input: DecideInput) {
    const decision = String(input?.decision ?? '');
    if (!DECISIONS.has(decision)) throw new BadRequestException('审批决策非法');

    const request = await this.prisma.approvalRequest.findUnique({
      where: { id: approvalRequestId },
      select: {
        id: true,
        approverId: true,
        submitterId: true,
        status: true,
        workLogVersionId: true,
        workLogVersion: {
          select: {
            id: true,
            versionNumber: true,
            workLog: {
              select: {
                id: true,
                number: true,
                projectId: true,
                authorId: true,
                status: true,
                currentVersionId: true,
                version: true,
              },
            },
          },
        },
      },
    });
    // 非本人审批的请求与不存在的请求同一响应，避免探测存在性。
    if (!request || request.approverId !== userId) throw new NotFoundException('审批请求不存在');

    if (request.submitterId === userId || request.workLogVersion.workLog.authorId === userId) {
      throw new ForbiddenException('不能审批自己提交的工作日志');
    }
    if (request.status !== 'PENDING') throw new ConflictException('该审批请求已处理');
    if (request.workLogVersion.workLog.status !== 'SUBMITTED') {
      throw new ConflictException('工作日志不在待审批状态');
    }
    if (request.workLogVersion.workLog.currentVersionId !== request.workLogVersionId) {
      // 版本已被替换（重指向）：旧请求不得作用到新版本上。
      throw new ConflictException('审批请求对应的版本已不是当前版本');
    }

    // 会话内授权撤回必须生效：审批人若已被移出项目/降级/账号停用，不得继续改变日志状态。
    // 能力查询放在事务外（权限是全局的）；事务内再读角色与项目状态，收窄撤权窗口。
    const { hasCapability } = await this.assertStillEligibleApprover(
      userId,
      request.workLogVersion.workLog.projectId,
    );

    const comment = typeof input?.comment === 'string' ? input.comment.trim() : '';
    if (decision !== 'APPROVED' && comment.length === 0) {
      throw new BadRequestException('退回或拒绝必须填写意见');
    }

    const log = request.workLogVersion.workLog;
    const nextStatus =
      WORK_LOG_STATUS_BY_DECISION[decision as keyof typeof WORK_LOG_STATUS_BY_DECISION];

    return this.prisma.$transaction(async (tx) => {
      // 事务内再查一次：成员行、角色、项目状态都必须在提交时仍然有效，
      // 否则"校验通过后、提交前被撤权/降级/归档"会让决策照常落地。
      const liveLog = await tx.workLog.findFirst({
        where: { id: log.id, deletedAt: null },
        select: { id: true },
      });
      if (!liveLog) throw new NotFoundException('工作日志不存在');

      const stillMember = await tx.projectMembership.findFirst({
        where: {
          userId,
          projectId: log.projectId,
          user: { status: 'ACTIVE', deletedAt: null },
          // 与 assertProjectAccess 同口径：只排除归档，ON_HOLD/COMPLETED 仍可审批。
          project: { status: { not: 'ARCHIVED' }, deletedAt: null },
        },
        select: { id: true, roles: { select: { role: true } } },
      });
      // 成员资格/项目状态丢失按"不可见"处理（404），角色降级才是 403。
      if (!stillMember) throw new NotFoundException('项目不存在');
      const stillApprover = stillMember.roles.some((entry) => entry.role === 'APPROVER');
      if (!stillApprover && !hasCapability) {
        throw new ForbiddenException('你已不是该项目的审批人');
      }

      const processed = await tx.approvalRequest.updateMany({
        where: { id: request.id, approverId: userId, status: 'PENDING' },
        data: { status: decision as 'APPROVED' | 'RETURNED' | 'REJECTED', processedAt: new Date() },
      });
      if (processed.count !== 1) throw new ConflictException('该审批请求已处理');

      await tx.approvalDecision.create({
        data: {
          approvalRequestId: request.id,
          decision: decision as 'APPROVED' | 'RETURNED' | 'REJECTED',
          comment: comment.length > 0 ? comment : null,
          decidedById: userId,
        },
      });

      const advanced = await tx.workLog.updateMany({
        where: {
          id: log.id,
          status: 'SUBMITTED',
          currentVersionId: request.workLogVersionId,
          version: log.version,
        },
        data: { status: nextStatus, version: { increment: 1 } },
      });
      if (advanced.count !== 1) throw new ConflictException('工作日志状态已变化，请刷新后重试');

      await tx.projectEvent.create({
        data: {
          projectId: log.projectId,
          eventType: `WORK_LOG_${decision}`,
          summary: `工作日志 ${log.number} ${decision === 'APPROVED' ? '已通过审批' : decision === 'RETURNED' ? '被退回修改' : '被拒绝'}`,
          actorId: userId,
        },
      });

      await tx.notification.create({
        data: {
          userId: request.submitterId,
          eventType: `WORK_LOG_${decision}`,
          resourceType: 'WORK_LOG',
          resourceId: log.id,
          title: `工作日志 ${log.number}`,
          body:
            decision === 'APPROVED'
              ? '审批已通过'
              : decision === 'RETURNED'
                ? `审批退回：${comment}`
                : `审批拒绝：${comment}`,
        },
      });

      // 邮件只入队，发送由后台任务负责：发送失败不会回滚这里的业务事务。
      const submitter = await tx.user.findUnique({
        where: { id: request.submitterId },
        select: { workEmail: true },
      });
      if (submitter?.workEmail) {
        await tx.emailOutbox.create({
          data: {
            toAddress: submitter.workEmail,
            subject: `工作日志 ${log.number} 审批结果`,
            body:
              decision === 'APPROVED'
                ? '你的工作日志已通过审批。'
                : `你的工作日志审批结果为 ${decision}${comment ? `：${comment}` : ''}`,
          },
        });
      }

      return { id: request.id, status: decision, workLogStatus: nextStatus };
    });
  }
}
