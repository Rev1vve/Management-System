import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { AttachmentsController, contentDisposition } from './attachments.controller';

function audit() {
  return { record: vi.fn().mockResolvedValue(undefined) };
}

describe('AttachmentsController', () => {
  const request = { user: { id: 'actor-1' } } as never;

  it('returns only the public list supplied by the authorized service', async () => {
    const service = {
      listWithCapability: vi
        .fn()
        .mockResolvedValue({ items: [{ id: 'a1', originalName: '合同.pdf' }], canManage: true }),
    };
    const controller = new AttachmentsController(service as never, audit() as never);

    await expect(controller.list(request, 'customer-1')).resolves.toEqual({
      items: [{ id: 'a1', originalName: '合同.pdf' }],
      canManage: true,
    });
    expect(service.listWithCapability).toHaveBeenCalledWith('actor-1', 'customer-1');
  });

  it('encodes download names without CRLF or quoted-header injection', () => {
    const value = contentDisposition('合同"\r\nX-Evil: yes.pdf');
    expect(value).toMatch(/^attachment; filename\*=UTF-8''/);
    expect(value).not.toMatch(/[\r\n"]/);
    expect(value).toContain('%E5%90%88%E5%90%8C');
  });

  it('derives canManage from the service instead of assuming every reader can write', async () => {
    const service = {
      listWithCapability: vi.fn().mockResolvedValue({
        items: [{ id: 'a1', originalName: '合同.pdf' }],
        canManage: false,
      }),
    };
    const controller = new AttachmentsController(service as never, audit() as never);

    await expect(controller.list(request, 'customer-1')).resolves.toEqual({
      items: [{ id: 'a1', originalName: '合同.pdf' }],
      canManage: false,
    });
  });

  it('audits successful contract attachment list, upload, download and archive operations', async () => {
    const stream = { destroy: vi.fn() };
    const service = {
      listWithCapability: vi.fn().mockResolvedValue({ items: [], canManage: true }),
      upload: vi
        .fn()
        .mockResolvedValue({ id: 'attachment-1', originalName: 'secret-contract.pdf' }),
      download: vi.fn().mockResolvedValue({
        id: 'attachment-1',
        originalName: 'secret-contract.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 12,
        stream,
      }),
      archive: vi.fn().mockResolvedValue({ ok: true }),
    };
    const auditService = audit();
    const controller = new AttachmentsController(service as never, auditService as never);
    const response = { setHeader: vi.fn() } as never;
    const file = {
      originalname: 'secret-contract.pdf',
      mimetype: 'application/pdf',
      size: 12,
      buffer: Buffer.from('%PDF-secret'),
    };

    await controller.list(request, 'customer-1');
    await controller.upload(request, 'customer-1', file);
    await controller.download(request, 'customer-1', 'attachment-1', response);
    await controller.archive(request, 'customer-1', 'attachment-1');

    expect(auditService.record).toHaveBeenCalledTimes(4);
    expect(auditService.record.mock.calls.map(([entry]) => entry)).toEqual([
      expect.objectContaining({
        actorId: 'actor-1',
        action: 'contract_attachment.list',
        resourceType: 'customer',
        resourceId: 'customer-1',
        result: 'SUCCESS',
      }),
      expect.objectContaining({
        actorId: 'actor-1',
        action: 'contract_attachment.upload',
        resourceType: 'attachment',
        resourceId: 'attachment-1',
        result: 'SUCCESS',
      }),
      expect.objectContaining({
        actorId: 'actor-1',
        action: 'contract_attachment.download',
        resourceType: 'attachment',
        resourceId: 'attachment-1',
        result: 'SUCCESS',
      }),
      expect.objectContaining({
        actorId: 'actor-1',
        action: 'contract_attachment.archive',
        resourceType: 'attachment',
        resourceId: 'attachment-1',
        result: 'SUCCESS',
      }),
    ]);
    expect(JSON.stringify(auditService.record.mock.calls)).not.toContain('secret-contract.pdf');
    expect(JSON.stringify(auditService.record.mock.calls)).not.toContain('%PDF-secret');
  });

  it('audits denied attachment operations without sensitive request metadata', async () => {
    const service = {
      upload: vi.fn().mockRejectedValue(new ForbiddenException()),
    };
    const auditService = audit();
    const controller = new AttachmentsController(service as never, auditService as never);
    const file = {
      originalname: 'private-agreement.pdf',
      mimetype: 'application/pdf',
      size: 12,
      buffer: Buffer.from('%PDF-private'),
    };

    await expect(controller.upload(request, 'customer-1', file)).rejects.toBeInstanceOf(
      ForbiddenException,
    );

    expect(auditService.record).toHaveBeenCalledWith({
      actorId: 'actor-1',
      action: 'contract_attachment.upload',
      resourceType: 'customer',
      resourceId: 'customer-1',
      result: 'FAILURE',
      summary: '合同附件操作失败',
      redactSensitive: false,
    });
    expect(JSON.stringify(auditService.record.mock.calls)).not.toContain('private-agreement.pdf');
    expect(JSON.stringify(auditService.record.mock.calls)).not.toContain('%PDF-private');
  });

  it('audits a denied download even when the service rejects before opening a stream', async () => {
    const service = {
      download: vi.fn().mockRejectedValue(new ForbiddenException()),
    };
    const auditService = audit();
    const controller = new AttachmentsController(service as never, auditService as never);

    await expect(
      controller.download(request, 'customer-1', 'attachment-1', { setHeader: vi.fn() } as never),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(auditService.record).toHaveBeenCalledWith({
      actorId: 'actor-1',
      action: 'contract_attachment.download',
      resourceType: 'attachment',
      resourceId: 'attachment-1',
      result: 'FAILURE',
      summary: '合同附件操作失败',
      redactSensitive: false,
    });
  });
});
