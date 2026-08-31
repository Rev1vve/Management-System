import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';

import { PortfoliosService } from './portfolios.service';
import { PermissionsGuard } from '../authorization/permissions.guard';
import { Permissions } from '../authorization/permissions.decorator';
import { PERMISSIONS } from '../authorization/permission.constants';
import {
  assertAllowedFields,
  optionalString,
  parseListQuery,
  requireString,
} from '../business-query';

const STATUSES = ['ACTIVE', 'ARCHIVED'] as const;
const SORT_FIELDS = ['name', 'status', 'updatedAt'] as const;
type Authenticated = Request & { user: { id: string } };

@UseGuards(PermissionsGuard)
@Controller('portfolios')
export class PortfoliosController {
  constructor(private readonly portfolios: PortfoliosService) {}

  @Get()
  list(@Req() request: Authenticated, @Query() query: Record<string, unknown>) {
    return this.portfolios.list(
      request.user.id,
      parseListQuery(query, { statuses: STATUSES, sortFields: SORT_FIELDS }),
    );
  }

  @Get(':portfolioId')
  get(@Req() request: Authenticated, @Param('portfolioId') portfolioId: string) {
    return this.portfolios.get(request.user.id, portfolioId);
  }

  @Permissions(PERMISSIONS.PORTFOLIO_MANAGE)
  @Post()
  create(@Req() request: Authenticated, @Body() body: unknown) {
    assertAllowedFields(body, ['name', 'description']);
    const description = optionalString(body.description, 'description', 2000);
    return this.portfolios.create(request.user.id, {
      name: requireString(body.name, 'name', 200),
      ...(description === undefined ? {} : { description }),
    });
  }

  @Permissions(PERMISSIONS.PORTFOLIO_MANAGE)
  @Patch(':portfolioId')
  update(
    @Req() request: Authenticated,
    @Param('portfolioId') portfolioId: string,
    @Body() body: unknown,
  ) {
    assertAllowedFields(body, ['name', 'description', 'status']);
    const status = body.status;
    if (status !== undefined && !STATUSES.includes(status as (typeof STATUSES)[number]))
      throw new BadRequestException('非法 status');
    const description = optionalString(body.description, 'description', 2000);
    return this.portfolios.update(request.user.id, portfolioId, {
      ...(body.name === undefined ? {} : { name: requireString(body.name, 'name', 200) }),
      ...(description === undefined ? {} : { description }),
      ...(status === undefined ? {} : { status }),
    });
  }

  @Permissions(PERMISSIONS.PORTFOLIO_MANAGE)
  @Post(':portfolioId/archive')
  archive(@Req() request: Authenticated, @Param('portfolioId') portfolioId: string) {
    return this.portfolios.archive(request.user.id, portfolioId);
  }
}
