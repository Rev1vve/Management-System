import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';

import { PermissionsGuard } from '../authorization/permissions.guard';
import { ApprovalsService } from './approvals.service';

type Authenticated = Request & { user: { id: string } };

/**
 * 单级审批（任务 9）。
 *
 * 审批人作用域由服务层强制：非本人审批的请求返回 404，与不存在同一响应。
 */
@UseGuards(PermissionsGuard)
@Controller('approvals')
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Get()
  list(@Req() request: Authenticated, @Query() query: Record<string, unknown>) {
    return this.approvals.listPending(request.user.id, {
      page: Number(query.page ?? 1),
      pageSize: Number(query.pageSize ?? 20),
    });
  }

  @Post(':id/decisions')
  decide(
    @Req() request: Authenticated,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.approvals.decide(request.user.id, id, {
      decision: body.decision as string,
      comment: typeof body.comment === 'string' ? body.comment : null,
    });
  }
}
