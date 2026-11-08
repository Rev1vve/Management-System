import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';

import { PermissionsGuard } from '../authorization/permissions.guard';
import { ReportsService } from './reports.service';

type Authenticated = Request & { user: { id: string } };

/**
 * 报表（任务 10）。作用域与下钻授权都由服务层强制，路由参数不可信。
 */
@UseGuards(PermissionsGuard)
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('summary')
  summary(@Req() request: Authenticated, @Query() query: Record<string, unknown>) {
    return this.reports.summary(request.user.id, {
      from: typeof query.from === 'string' ? query.from : null,
      to: typeof query.to === 'string' ? query.to : null,
    });
  }

  @Get('managed-projects')
  managedProjects(@Req() request: Authenticated, @Query() query: Record<string, unknown>) {
    return this.reports.managedProjects(request.user.id, {
      from: typeof query.from === 'string' ? query.from : null,
      to: typeof query.to === 'string' ? query.to : null,
    });
  }

  @Get('portfolios')
  portfolios(@Req() request: Authenticated, @Query() query: Record<string, unknown>) {
    return this.reports.portfolios(request.user.id, {
      from: typeof query.from === 'string' ? query.from : null,
      to: typeof query.to === 'string' ? query.to : null,
    });
  }

  @Get('projects')
  byProject(@Req() request: Authenticated, @Query() query: Record<string, unknown>) {
    return this.reports.byProject(request.user.id, {
      from: typeof query.from === 'string' ? query.from : null,
      to: typeof query.to === 'string' ? query.to : null,
    });
  }

  @Get('projects/:projectId/work-logs')
  drilldown(
    @Req() request: Authenticated,
    @Param('projectId') projectId: string,
    @Query() query: Record<string, unknown>,
  ) {
    return this.reports.drilldown(request.user.id, projectId, {
      from: typeof query.from === 'string' ? query.from : null,
      to: typeof query.to === 'string' ? query.to : null,
    });
  }
}
