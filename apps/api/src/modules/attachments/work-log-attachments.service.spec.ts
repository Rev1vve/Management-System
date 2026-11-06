import { ConflictException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { WorkLogAttachmentsService } from './work-log-attachments.service';

/**
 * 工作日志附件（D-D）：作者本人 + 草稿可写；提交时绑定版本；下载重验身份。
 * 存储管道本身的正确性由 attachments.service.spec.ts 覆盖，这里只固定授权与生命周期。
 */
function createPrisma(log: Record<string, unknown> | null) {
  return {
    workLog: { findFirst: vi.fn().mockResolvedValue(log) },
    attachment: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findMany: vi.fn().mockResolvedValue([{ id: 'a1' }]),
      findFirstOrThrow: vi.fn().mockResolvedValue({ id: 'a1', originalName: 'x.pdf' }),
      findFirst: vi.fn().mockResolvedValue({
        id: 'a1',
        originalName: 'x.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 16,
        storageKey: 'work-log/aa/aa000000-0000-4000-8000-000000000000.pdf',
        storageDevice: 1n,
        storageInode: 2n,
      }),
    },
  };
}

function createService(prisma: ReturnType<typeof createPrisma>) {
  const attachments = {
    validateFile: vi.fn().mockReturnValue({
      originalName: 'x.pdf',
      extension: '.pdf',
      mime: 'application/pdf',
    }),
    storeAttachmentFile: vi.fn().mockResolvedValue('pending-1'),
    openVerifiedAttachmentStream: vi.fn().mockResolvedValue({ stream: 'stream' }),
  };
  return {
    service: new WorkLogAttachmentsService(prisma as never, attachments as never),
    attachments,
  };
}

const draftLog = {
  id: 'wl-1',
  status: 'DRAFT',
  projectId: 'project-1',
  currentVersionId: 'wlv-1',
};

describe('WorkLogAttachmentsService', () => {
  it('uploads under the work-log storage prefix and activates only for the author draft', async () => {
    const prisma = createPrisma({ ...draftLog });
    const { service, attachments } = createService(prisma);

    await service.upload('author-1', 'wl-1', { buffer: Buffer.from('%PDF-1.7'), size: 8 } as never);

    expect(attachments.storeAttachmentFile).toHaveBeenCalledWith(
      expect.objectContaining({
        storageKey: expect.stringMatching(/^work-log\/[0-9a-f]{2}\/[0-9a-f-]{36}\.pdf$/),
        createData: expect.objectContaining({ resourceType: 'WORK_LOG', resourceId: 'wl-1' }),
      }),
    );
    expect(prisma.attachment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'pending-1',
          status: 'PENDING',
          workLog: { is: expect.objectContaining({ authorId: 'author-1', status: 'DRAFT' }) },
        }),
        data: { status: 'ACTIVE' },
      }),
    );
  });

  it('rejects upload once the log left DRAFT', async () => {
    const prisma = createPrisma({ ...draftLog, status: 'SUBMITTED' });
    const { service, attachments } = createService(prisma);

    await expect(
      service.upload('author-1', 'wl-1', { buffer: Buffer.from('x') } as never),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(attachments.storeAttachmentFile).not.toHaveBeenCalled();
  });

  it('rejects another user with 404', async () => {
    const prisma = createPrisma(null);
    const { service } = createService(prisma);

    await expect(
      service.upload('intruder', 'wl-1', { buffer: Buffer.from('x') } as never),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.list('intruder', 'wl-1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('downloads through the shared verified stream and scopes by author', async () => {
    const prisma = createPrisma(draftLog);
    const { service, attachments } = createService(prisma);

    const result = await service.download('author-1', 'wl-1', 'a1');

    expect(prisma.attachment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'a1',
          workLogId: 'wl-1',
          status: 'ACTIVE',
          workLog: { is: expect.objectContaining({ authorId: 'author-1' }) },
        }),
      }),
    );
    expect(attachments.openVerifiedAttachmentStream).toHaveBeenCalledOnce();
    expect(result.stream).toBe('stream');
  });

  it('only lists attachments that are visible for the current version', async () => {
    const prisma = createPrisma({ ...draftLog, currentVersionId: 'wlv-2' });
    const { service } = createService(prisma);

    await service.list('author-1', 'wl-1');

    expect(prisma.attachment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          workLogId: 'wl-1',
          OR: [
            { resourceType: 'WORK_LOG' },
            { resourceType: 'WORK_LOG_VERSION', resourceId: 'wlv-2' },
          ],
        }),
      }),
    );
  });

  it('refuses archiving an already frozen (version-bound) attachment', async () => {
    const prisma = createPrisma(draftLog);
    prisma.attachment.updateMany.mockResolvedValue({ count: 0 });
    const { service } = createService(prisma);

    await expect(service.archive('author-1', 'wl-1', 'a1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
