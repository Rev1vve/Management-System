import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Post,
  Req,
  Res,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { basename } from 'node:path';
import type { Request, Response } from 'express';

import {
  AttachmentsService,
  MAX_ATTACHMENT_BYTES,
  type BufferedUpload,
} from './attachments.service';
import { Permissions } from '../authorization/permissions.decorator';
import { PERMISSIONS } from '../authorization/permission.constants';
import { PermissionsGuard } from '../authorization/permissions.guard';
import { AuditService } from '../audit/audit.service';

type Authenticated = Request & { user: { id: string } };

export function contentDisposition(originalName: string): string {
  const cleaned =
    basename(originalName.replace(/[\x00-\x1f\x7f"]/g, '')).slice(0, 255) || 'attachment';
  const encoded = encodeURIComponent(cleaned).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename*=UTF-8''${encoded}`;
}

@UseGuards(PermissionsGuard)
@Controller('customers/:customerId/contract-attachments')
export class AttachmentsController {
  constructor(
    private readonly attachments: AttachmentsService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async list(@Req() request: Authenticated, @Param('customerId') customerId: string) {
    try {
      const result = await this.attachments.listWithCapability(request.user.id, customerId);
      await this.recordAudit(request.user.id, 'contract_attachment.list', 'customer', customerId);
      return result;
    } catch (error) {
      await this.recordAudit(
        request.user.id,
        'contract_attachment.list',
        'customer',
        customerId,
        'FAILURE',
      );
      throw error;
    }
  }

  @Permissions(PERMISSIONS.PROJECT_MANAGE)
  @Post()
  @UseInterceptors(
    FileInterceptor('file', { limits: { files: 1, fileSize: MAX_ATTACHMENT_BYTES } }),
  )
  async upload(
    @Req() request: Authenticated,
    @Param('customerId') customerId: string,
    @UploadedFile() file: BufferedUpload | undefined,
  ) {
    try {
      if (!file) throw new BadRequestException('缺少附件');
      const result = await this.attachments.upload(request.user.id, customerId, file);
      await this.recordAudit(
        request.user.id,
        'contract_attachment.upload',
        'attachment',
        result.id,
      );
      return result;
    } catch (error) {
      await this.recordAudit(
        request.user.id,
        'contract_attachment.upload',
        'customer',
        customerId,
        'FAILURE',
      );
      throw error;
    }
  }

  @Get(':attachmentId/download')
  async download(
    @Req() request: Authenticated,
    @Param('customerId') customerId: string,
    @Param('attachmentId') attachmentId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    let stream: Awaited<ReturnType<AttachmentsService['download']>>['stream'] | undefined;
    try {
      const attachment = await this.attachments.download(request.user.id, customerId, attachmentId);
      stream = attachment.stream;
      response.setHeader('Content-Type', attachment.mimeType);
      response.setHeader('Content-Length', String(attachment.sizeBytes));
      response.setHeader('Content-Disposition', contentDisposition(attachment.originalName));
      response.setHeader('X-Content-Type-Options', 'nosniff');
      await this.recordAudit(
        request.user.id,
        'contract_attachment.download',
        'attachment',
        attachment.id,
      );
      return new StreamableFile(stream);
    } catch (error) {
      stream?.destroy();
      await this.recordAudit(
        request.user.id,
        'contract_attachment.download',
        'attachment',
        attachmentId,
        'FAILURE',
      );
      throw error;
    }
  }

  @Permissions(PERMISSIONS.PROJECT_MANAGE)
  @Post(':attachmentId/archive')
  async archive(
    @Req() request: Authenticated,
    @Param('customerId') customerId: string,
    @Param('attachmentId') attachmentId: string,
  ) {
    try {
      const result = await this.attachments.archive(request.user.id, customerId, attachmentId);
      await this.recordAudit(
        request.user.id,
        'contract_attachment.archive',
        'attachment',
        attachmentId,
      );
      return result;
    } catch (error) {
      await this.recordAudit(
        request.user.id,
        'contract_attachment.archive',
        'attachment',
        attachmentId,
        'FAILURE',
      );
      throw error;
    }
  }

  private recordAudit(
    actorId: string,
    action: string,
    resourceType: string,
    resourceId: string,
    result: 'SUCCESS' | 'FAILURE' = 'SUCCESS',
  ) {
    return this.audit.record({
      actorId,
      action,
      resourceType,
      resourceId,
      result,
      summary: result === 'SUCCESS' ? '合同附件操作成功' : '合同附件操作失败',
      redactSensitive: false,
    });
  }
}
