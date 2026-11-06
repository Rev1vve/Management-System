import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { PrismaService } from '../../database/prisma.service';
import { AttachmentsService, type BufferedUpload } from '../attachments/attachments.service';

/**
 * 工作日志附件（任务 8，D-D）。
 *
 * 与客户合同附件共用同一套存储管道（PENDING → 发布 → ACTIVE、身份校验、崩溃恢复），
 * 但授权与生命周期完全按工作日志语义：
 *  - 只有作者本人、且日志仍是 DRAFT 时可以上传/删除草稿附件；
 *  - 提交时由 work-logs 服务在同一事务内把 ACTIVE 附件从 WORK_LOG 重绑到
 *    WORK_LOG_VERSION（冻结到具体版本）——退回后的新草稿天然不继承旧附件；
 *  - 下载每次都重新校验作者身份与附件仍是 ACTIVE，且文件身份与持久化记录一致。
 */
export const WORK_LOG_RESOURCE = 'WORK_LOG' as const;
export const WORK_LOG_VERSION_RESOURCE = 'WORK_LOG_VERSION' as const;

export const PUBLIC_WORK_LOG_ATTACHMENT_SELECT = {
  id: true,
  originalName: true,
  mimeType: true,
  sizeBytes: true,
  createdAt: true,
} as const;

@Injectable()
export class WorkLogAttachmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly attachments: AttachmentsService,
  ) {}

  private async loadOwnedDraft(userId: string, workLogId: string) {
    const log = await this.prisma.workLog.findFirst({
      where: { id: workLogId, authorId: userId, deletedAt: null },
      select: { id: true, status: true, projectId: true, currentVersionId: true },
    });
    // 他人的日志与不存在的日志同一响应，避免探测存在性。
    if (!log) throw new NotFoundException('工作日志不存在');
    if (log.status !== 'DRAFT') throw new ConflictException('只有草稿可以修改附件');
    return log;
  }

  /**
   * "当前可见"附件的过滤条件：未绑定的草稿附件，或绑定到当前版本的附件。
   * 退回后的新草稿 currentVersionId 已指向新版本，旧版本冻结附件因此不可见/不可下载。
   */
  private visibleAttachmentFilter(currentVersionId: string | null) {
    return {
      OR: [
        { resourceType: WORK_LOG_RESOURCE },
        ...(currentVersionId
          ? [{ resourceType: WORK_LOG_VERSION_RESOURCE, resourceId: currentVersionId }]
          : []),
      ],
    };
  }

  async upload(userId: string, workLogId: string, file: BufferedUpload) {
    const log = await this.loadOwnedDraft(userId, workLogId);
    const validated = this.attachments.validateFile(file);
    const id = randomUUID();
    const storageKey = `work-log/${id.slice(0, 2)}/${id}${validated.extension}`;

    const pendingId = await this.attachments.storeAttachmentFile({
      userId,
      file,
      validated,
      storageKey,
      createData: {
        resourceType: WORK_LOG_RESOURCE,
        resourceId: log.id,
        workLog: { connect: { id: log.id } },
      },
      onRelationLost: async () => {
        throw new NotFoundException('工作日志不存在');
      },
    });

    // 激活时再次确认"作者 + 仍是草稿"：上传期间被提交或撤权都不能留下可见附件。
    const activated = await this.prisma.attachment.updateMany({
      where: {
        id: pendingId,
        status: 'PENDING',
        storagePublishedAt: { not: null },
        workLog: { is: { authorId: userId, status: 'DRAFT', deletedAt: null } },
      },
      data: { status: 'ACTIVE' },
    });
    if (activated.count !== 1) {
      // 保留 PENDING 行与已发布文件，交由启动 reconciliation 处理，不在这里删证据。
      throw new ConflictException('工作日志状态已变化，请刷新后重试');
    }

    return this.prisma.attachment.findFirstOrThrow({
      where: { id: pendingId },
      select: PUBLIC_WORK_LOG_ATTACHMENT_SELECT,
    });
  }

  async list(userId: string, workLogId: string) {
    const log = await this.prisma.workLog.findFirst({
      where: { id: workLogId, authorId: userId, deletedAt: null },
      select: { id: true, currentVersionId: true },
    });
    if (!log) throw new NotFoundException('工作日志不存在');
    return this.prisma.attachment.findMany({
      where: {
        workLogId,
        status: 'ACTIVE',
        deletedAt: null,
        // 只展示"当前可见"的附件：未绑定的草稿附件，或已绑定到当前版本的附件。
        // 退回后新草稿的 currentVersionId 指向新版本，旧版本的冻结附件因此不再出现（D-D）。
        ...this.visibleAttachmentFilter(log.currentVersionId),
      },
      select: PUBLIC_WORK_LOG_ATTACHMENT_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    });
  }

  async download(userId: string, workLogId: string, attachmentId: string) {
    const log = await this.prisma.workLog.findFirst({
      where: { id: workLogId, authorId: userId, deletedAt: null },
      select: { id: true, currentVersionId: true },
    });
    if (!log) throw new NotFoundException('工作日志不存在');
    const attachment = await this.prisma.attachment.findFirst({
      where: {
        id: attachmentId,
        workLogId,
        status: 'ACTIVE',
        deletedAt: null,
        ...this.visibleAttachmentFilter(log.currentVersionId),
        workLog: { is: { authorId: userId, deletedAt: null } },
      },
      select: {
        id: true,
        originalName: true,
        mimeType: true,
        sizeBytes: true,
        storageKey: true,
        storageDevice: true,
        storageInode: true,
      },
    });
    if (!attachment) throw new NotFoundException('附件不存在');

    const { stream } = await this.attachments.openVerifiedAttachmentStream(attachment);
    return {
      id: attachment.id,
      originalName: attachment.originalName,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      stream,
    };
  }

  async archive(userId: string, workLogId: string, attachmentId: string) {
    const log = await this.loadOwnedDraft(userId, workLogId);
    const archived = await this.prisma.attachment.updateMany({
      where: {
        id: attachmentId,
        workLogId: log.id,
        status: 'ACTIVE',
        deletedAt: null,
        resourceType: WORK_LOG_RESOURCE,
      },
      data: {
        status: 'ARCHIVED',
        deletedAt: new Date(),
        storageDeletedAt: null,
        storageCleanupAttempts: 0,
        storageCleanupLastError: null,
      },
    });
    if (archived.count !== 1) {
      // 与其他端点一致：跨日志/不存在/已冻结都按不可见处理，避免泄露存在性。
      throw new NotFoundException('附件不存在');
    }
    return { ok: true };
  }
}
