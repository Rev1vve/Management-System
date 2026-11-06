import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';

import { PermissionsGuard } from '../authorization/permissions.guard';
import {
  type CreateWorkLogInput,
  type VersionContentInput,
  WorkLogsService,
} from './work-logs.service';

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

  /** 退回后开新版本（仅作者、仅 RETURNED）。 */
  @Post('work-logs/:id/versions')
  addVersion(
    @Req() request: Authenticated,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.workLogs.addVersion(request.user.id, id, body as unknown as VersionContentInput);
  }

  /** 编辑草稿当前版本（仅作者、仅 DRAFT）。 */
  @Patch('work-logs/:id')
  updateDraft(
    @Req() request: Authenticated,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    const { version, ...content } = body;
    return this.workLogs.updateDraft(
      request.user.id,
      id,
      content as unknown as VersionContentInput,
      version as number,
    );
  }

  /** 日志详情（作者本人）：含乐观并发令牌 version 与当前版本内容。 */
  @Get('work-logs/:id')
  detail(@Req() request: Authenticated, @Param('id') id: string) {
    return this.workLogs.getDetail(request.user.id, id);
  }

  /** 设置可见性（D-A：项目经理 或 worklog:manage）。 */
  @Patch('work-logs/:id/visibility')
  setVisibility(
    @Req() request: Authenticated,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.workLogs.setVisibility(request.user.id, id, {
      visibility: body.visibility as string,
      version: body.version,
    });
  }

  /** 最小可见性元数据入口（D-B）：仅 id/visibility/version。 */
  @Get('projects/:projectId/work-logs/visibility')
  listVisibility(
    @Req() request: Authenticated,
    @Param('projectId') projectId: string,
    @Query() query: Record<string, unknown>,
  ) {
    return this.workLogs.listVisibilityMetadata(request.user.id, projectId, {
      page: Number(query.page ?? 1),
      pageSize: Number(query.pageSize ?? 20),
    });
  }
}
