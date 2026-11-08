import { Body, Controller, Get, Param, Patch, Put, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';

import { PERMISSIONS } from '../authorization/permission.constants';
import { Permissions } from '../authorization/permissions.decorator';
import { PermissionsGuard } from '../authorization/permissions.guard';
import { AdminAuditService } from './admin-audit.service';
import { AdminUsersService } from './admin-users.service';

type Authenticated = Request & { user: { id: string } };

/**
 * 管理中心 API（任务 11）。
 *
 * 全部端点显式声明权限：ADMIN 角色默认只有管理能力，不会因此获得业务数据读取权。
 */
@UseGuards(PermissionsGuard)
@Controller('admin')
export class AdminController {
  constructor(
    private readonly users: AdminUsersService,
    private readonly audit: AdminAuditService,
  ) {}

  @Get('users')
  @Permissions(PERMISSIONS.USER_MANAGE)
  listUsers(@Query() query: Record<string, unknown>) {
    return this.users.listUsers({
      page: Number(query.page ?? 1),
      pageSize: Number(query.pageSize ?? 20),
      search: typeof query.search === 'string' ? query.search : '',
    });
  }

  @Patch('users/:id/status')
  @Permissions(PERMISSIONS.USER_MANAGE)
  setStatus(
    @Req() request: Authenticated,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.users.setStatus(request.user.id, id, String(body.status ?? ''));
  }

  @Put('users/:id/roles')
  @Permissions(PERMISSIONS.USER_MANAGE)
  setRoles(
    @Req() request: Authenticated,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    const roles = Array.isArray(body.roles) ? body.roles.map(String) : [];
    return this.users.setRoles(request.user.id, id, roles);
  }

  @Get('roles')
  @Permissions(PERMISSIONS.USER_MANAGE)
  listRoles() {
    return this.users.listRoles();
  }

  @Get('audit')
  @Permissions(PERMISSIONS.AUDIT_VIEW)
  listAudit(@Query() query: Record<string, unknown>) {
    return this.audit.list({
      page: Number(query.page ?? 1),
      pageSize: Number(query.pageSize ?? 20),
      actorId: typeof query.actorId === 'string' ? query.actorId : null,
      resourceType: typeof query.resourceType === 'string' ? query.resourceType : null,
      action: typeof query.action === 'string' ? query.action : null,
      from: typeof query.from === 'string' ? query.from : null,
      to: typeof query.to === 'string' ? query.to : null,
    });
  }
}
