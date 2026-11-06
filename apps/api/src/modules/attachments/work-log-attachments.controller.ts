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
import type { Request, Response } from 'express';

import { PermissionsGuard } from '../authorization/permissions.guard';
import { MAX_ATTACHMENT_BYTES, type BufferedUpload } from './attachments.service';
import { WorkLogAttachmentsService } from './work-log-attachments.service';

type Authenticated = Request & { user: { id: string } };

function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** 工作日志附件：作者本人 + 草稿可写，下载每次重验作者与文件身份。 */
@UseGuards(PermissionsGuard)
@Controller('work-logs/:workLogId/attachments')
export class WorkLogAttachmentsController {
  constructor(private readonly attachments: WorkLogAttachmentsService) {}

  @Get()
  list(@Req() request: Authenticated, @Param('workLogId') workLogId: string) {
    return this.attachments.list(request.user.id, workLogId);
  }

  @Post()
  @UseInterceptors(
    FileInterceptor('file', { limits: { files: 1, fileSize: MAX_ATTACHMENT_BYTES } }),
  )
  upload(
    @Req() request: Authenticated,
    @Param('workLogId') workLogId: string,
    @UploadedFile() file: BufferedUpload | undefined,
  ) {
    if (!file) throw new BadRequestException('缺少附件');
    return this.attachments.upload(request.user.id, workLogId, file);
  }

  @Get(':attachmentId/download')
  async download(
    @Req() request: Authenticated,
    @Param('workLogId') workLogId: string,
    @Param('attachmentId') attachmentId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const attachment = await this.attachments.download(request.user.id, workLogId, attachmentId);
    response.setHeader('Content-Type', attachment.mimeType);
    response.setHeader('Content-Length', String(attachment.sizeBytes));
    response.setHeader('Content-Disposition', contentDisposition(attachment.originalName));
    response.setHeader('X-Content-Type-Options', 'nosniff');
    return new StreamableFile(attachment.stream as never);
  }

  @Post(':attachmentId/archive')
  archive(
    @Req() request: Authenticated,
    @Param('workLogId') workLogId: string,
    @Param('attachmentId') attachmentId: string,
  ) {
    return this.attachments.archive(request.user.id, workLogId, attachmentId);
  }
}
