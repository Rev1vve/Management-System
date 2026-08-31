import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';

import { ProjectsService } from './projects.service';
import { PermissionsGuard } from '../authorization/permissions.guard';
import { Permissions } from '../authorization/permissions.decorator';
import { PERMISSIONS } from '../authorization/permission.constants';
import {
  assertAllowedFields,
  optionalDate,
  optionalString,
  parseListQuery,
  requireString,
  requireVersion,
} from '../business-query';

const STATUSES = ['DRAFT', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'ARCHIVED'] as const;
const ROLES = ['PROJECT_MANAGER', 'MEMBER', 'APPROVER', 'OBSERVER'] as const;
const SORT_FIELDS = ['number', 'name', 'status', 'completionPercent', 'updatedAt'] as const;
type Authenticated = Request & { user: { id: string } };

function optionalId(value: unknown, name: string): string | null | undefined {
  if (value === undefined || value === null) return value;
  return requireString(value, name, 100);
}
function optionalPercent(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 100)
    throw new BadRequestException('completionPercent 必须是 0-100 的整数');
  return value as number;
}
function projectRoles(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some(
      (role) => typeof role !== 'string' || !ROLES.includes(role as (typeof ROLES)[number]),
    )
  ) {
    throw new BadRequestException('项目角色非法');
  }
  return value as string[];
}

@UseGuards(PermissionsGuard)
@Controller('projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get()
  list(@Req() request: Authenticated, @Query() query: Record<string, unknown>) {
    return this.projects.list(
      request.user.id,
      parseListQuery(query, { statuses: STATUSES, sortFields: SORT_FIELDS }),
    );
  }
  @Get(':projectId')
  get(@Req() request: Authenticated, @Param('projectId') projectId: string) {
    return this.projects.get(request.user.id, projectId);
  }

  @Permissions(PERMISSIONS.PROJECT_MANAGE)
  @Post()
  create(@Req() request: Authenticated, @Body() body: unknown) {
    assertAllowedFields(body, [
      'number',
      'name',
      'customerId',
      'portfolioId',
      'description',
      'startDate',
      'endDate',
    ]);
    const customerId = optionalId(body.customerId, 'customerId');
    const portfolioId = optionalId(body.portfolioId, 'portfolioId');
    const description = optionalString(body.description, 'description', 4000);
    const startDate = optionalDate(body.startDate, 'startDate');
    const endDate = optionalDate(body.endDate, 'endDate');
    return this.projects.create(request.user.id, {
      number: requireString(body.number, 'number', 100),
      name: requireString(body.name, 'name', 200),
      ...(customerId === undefined ? {} : { customerId }),
      ...(portfolioId === undefined ? {} : { portfolioId }),
      ...(description === undefined ? {} : { description }),
      ...(startDate === undefined ? {} : { startDate }),
      ...(endDate === undefined ? {} : { endDate }),
    });
  }

  @Permissions(PERMISSIONS.PROJECT_MANAGE)
  @Patch(':projectId')
  update(
    @Req() request: Authenticated,
    @Param('projectId') projectId: string,
    @Body() body: unknown,
  ) {
    assertAllowedFields(body, [
      'number',
      'name',
      'customerId',
      'portfolioId',
      'description',
      'startDate',
      'endDate',
      'status',
      'completionPercent',
      'version',
    ]);
    const status = body.status;
    if (status !== undefined && !STATUSES.includes(status as (typeof STATUSES)[number]))
      throw new BadRequestException('非法 status');
    const customerId = optionalId(body.customerId, 'customerId');
    const portfolioId = optionalId(body.portfolioId, 'portfolioId');
    const description = optionalString(body.description, 'description', 4000);
    const startDate = optionalDate(body.startDate, 'startDate');
    const endDate = optionalDate(body.endDate, 'endDate');
    const completionPercent = optionalPercent(body.completionPercent);
    return this.projects.update(request.user.id, projectId, {
      version: requireVersion(body.version),
      ...(body.number === undefined ? {} : { number: requireString(body.number, 'number', 100) }),
      ...(body.name === undefined ? {} : { name: requireString(body.name, 'name', 200) }),
      ...(customerId === undefined ? {} : { customerId }),
      ...(portfolioId === undefined ? {} : { portfolioId }),
      ...(description === undefined ? {} : { description }),
      ...(startDate === undefined ? {} : { startDate }),
      ...(endDate === undefined ? {} : { endDate }),
      ...(status === undefined ? {} : { status }),
      ...(completionPercent === undefined ? {} : { completionPercent }),
    });
  }

  @Permissions(PERMISSIONS.PROJECT_MANAGE)
  @Post(':projectId/archive')
  archive(
    @Req() request: Authenticated,
    @Param('projectId') projectId: string,
    @Body() body: unknown,
  ) {
    assertAllowedFields(body, ['version']);
    return this.projects.archive(request.user.id, projectId, requireVersion(body.version));
  }

  @Get(':projectId/members')
  listMembers(@Req() request: Authenticated, @Param('projectId') projectId: string) {
    return this.projects.listMembers(request.user.id, projectId);
  }
  @Permissions(PERMISSIONS.PROJECT_MANAGE)
  @Post(':projectId/members')
  addMember(
    @Req() request: Authenticated,
    @Param('projectId') projectId: string,
    @Body() body: unknown,
  ) {
    assertAllowedFields(body, ['userId', 'roles']);
    return this.projects.addMember(
      request.user.id,
      projectId,
      requireString(body.userId, 'userId', 100),
      projectRoles(body.roles),
    );
  }
  @Permissions(PERMISSIONS.PROJECT_MANAGE)
  @Patch(':projectId/members/:userId')
  replaceMemberRoles(
    @Req() request: Authenticated,
    @Param('projectId') projectId: string,
    @Param('userId') userId: string,
    @Body() body: unknown,
  ) {
    assertAllowedFields(body, ['roles']);
    return this.projects.replaceMemberRoles(
      request.user.id,
      projectId,
      userId,
      projectRoles(body.roles),
    );
  }
  @Permissions(PERMISSIONS.PROJECT_MANAGE)
  @Delete(':projectId/members/:userId')
  removeMember(
    @Req() request: Authenticated,
    @Param('projectId') projectId: string,
    @Param('userId') userId: string,
  ) {
    return this.projects.removeMember(request.user.id, projectId, userId);
  }
}
