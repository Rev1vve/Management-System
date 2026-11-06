import { Body, Controller, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';

import { PermissionsGuard } from '../authorization/permissions.guard';
import { type CreateWorkLogInput, WorkLogsService } from './work-logs.service';

type Authenticated = Request & { user: { id: string } };

/**
 * 工作日志（任务 8 第一片）：创建草稿。
 *
 * 路由挂在项目下（`projects/:projectId/work-logs`），与订单/项目资源一致；
 * 项目作用域由服务层 ProjectAccessService 强制，不依赖路由参数的可信度。
 */
@UseGuards(PermissionsGuard)
@Controller()
export class WorkLogsController {
  constructor(private readonly workLogs: WorkLogsService) {}

  @Post('projects/:projectId/work-logs')
  create(
    @Req() request: Authenticated,
    @Param('projectId') projectId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.workLogs.createDraft(request.user.id, {
      ...body,
      projectId,
    } as unknown as CreateWorkLogInput);
  }

  @Post('work-logs/:id/submit')
  submit(
    @Req() request: Authenticated,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.workLogs.submit(request.user.id, id, {
      approverId: body.approverId as string,
    });
  }
}
