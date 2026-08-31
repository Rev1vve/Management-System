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

import { OrdersService } from './orders.service';
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

const ORDER_STATUSES = ['DRAFT', 'ACTIVE', 'COMPLETED', 'CANCELLED', 'ARCHIVED'] as const;
const ITEM_STATUSES = ['PENDING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'] as const;
const SORT_FIELDS = ['number', 'title', 'status', 'updatedAt'] as const;
type Authenticated = Request & { user: { id: string } };
function enumValue(value: unknown, values: readonly string[], name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !values.includes(value))
    throw new BadRequestException(`非法 ${name}`);
  return value;
}
function quantity(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    throw new BadRequestException('quantity 必须是非负数字');
  return value;
}
function sortOrder(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < 0)
    throw new BadRequestException('sortOrder 必须是非负整数');
  return value as number;
}

@UseGuards(PermissionsGuard)
@Controller('projects/:projectId/orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}
  @Get()
  list(
    @Req() request: Authenticated,
    @Param('projectId') projectId: string,
    @Query() query: Record<string, unknown>,
  ) {
    return this.orders.list(
      request.user.id,
      projectId,
      parseListQuery(query, { statuses: ORDER_STATUSES, sortFields: SORT_FIELDS }),
    );
  }
  @Get(':orderId')
  get(
    @Req() request: Authenticated,
    @Param('projectId') projectId: string,
    @Param('orderId') orderId: string,
  ) {
    return this.orders.get(request.user.id, projectId, orderId);
  }
  @Permissions(PERMISSIONS.PROJECT_MANAGE)
  @Post()
  create(
    @Req() request: Authenticated,
    @Param('projectId') projectId: string,
    @Body() body: unknown,
  ) {
    assertAllowedFields(body, [
      'number',
      'title',
      'description',
      'startDate',
      'deliveryDate',
      'status',
    ]);
    const description = optionalString(body.description, 'description', 4000);
    const startDate = optionalDate(body.startDate, 'startDate');
    const deliveryDate = optionalDate(body.deliveryDate, 'deliveryDate');
    const status = enumValue(body.status, ORDER_STATUSES, 'status');
    return this.orders.create(request.user.id, projectId, {
      number: requireString(body.number, 'number', 100),
      title: requireString(body.title, 'title', 200),
      ...(description === undefined ? {} : { description }),
      ...(startDate === undefined ? {} : { startDate }),
      ...(deliveryDate === undefined ? {} : { deliveryDate }),
      ...(status === undefined ? {} : { status }),
    });
  }
  @Permissions(PERMISSIONS.PROJECT_MANAGE)
  @Patch(':orderId')
  update(
    @Req() request: Authenticated,
    @Param('projectId') projectId: string,
    @Param('orderId') orderId: string,
    @Body() body: unknown,
  ) {
    assertAllowedFields(body, [
      'number',
      'title',
      'description',
      'startDate',
      'deliveryDate',
      'status',
      'version',
    ]);
    const description = optionalString(body.description, 'description', 4000);
    const startDate = optionalDate(body.startDate, 'startDate');
    const deliveryDate = optionalDate(body.deliveryDate, 'deliveryDate');
    const status = enumValue(body.status, ORDER_STATUSES, 'status');
    return this.orders.update(request.user.id, projectId, orderId, {
      version: requireVersion(body.version),
      ...(body.number === undefined ? {} : { number: requireString(body.number, 'number', 100) }),
      ...(body.title === undefined ? {} : { title: requireString(body.title, 'title', 200) }),
      ...(description === undefined ? {} : { description }),
      ...(startDate === undefined ? {} : { startDate }),
      ...(deliveryDate === undefined ? {} : { deliveryDate }),
      ...(status === undefined ? {} : { status }),
    });
  }
  @Permissions(PERMISSIONS.PROJECT_MANAGE)
  @Post(':orderId/archive')
  archive(
    @Req() request: Authenticated,
    @Param('projectId') projectId: string,
    @Param('orderId') orderId: string,
    @Body() body: unknown,
  ) {
    assertAllowedFields(body, ['version']);
    return this.orders.archive(request.user.id, projectId, orderId, requireVersion(body.version));
  }

  @Get(':orderId/items')
  listItems(
    @Req() request: Authenticated,
    @Param('projectId') projectId: string,
    @Param('orderId') orderId: string,
  ) {
    return this.orders.listItems(request.user.id, projectId, orderId);
  }
  @Permissions(PERMISSIONS.PROJECT_MANAGE)
  @Post(':orderId/items')
  createItem(
    @Req() request: Authenticated,
    @Param('projectId') projectId: string,
    @Param('orderId') orderId: string,
    @Body() body: unknown,
  ) {
    assertAllowedFields(body, [
      'version',
      'name',
      'quantity',
      'unit',
      'plannedDate',
      'completedDate',
      'status',
      'sortOrder',
    ]);
    const unit = optionalString(body.unit, 'unit', 50);
    const plannedDate = optionalDate(body.plannedDate, 'plannedDate');
    const completedDate = optionalDate(body.completedDate, 'completedDate');
    const status = enumValue(body.status, ITEM_STATUSES, 'status');
    const order = sortOrder(body.sortOrder);
    return this.orders.createItem(request.user.id, projectId, orderId, {
      version: requireVersion(body.version),
      name: requireString(body.name, 'name', 200),
      quantity: quantity(body.quantity),
      ...(unit === undefined ? {} : { unit }),
      ...(plannedDate === undefined ? {} : { plannedDate }),
      ...(completedDate === undefined ? {} : { completedDate }),
      ...(status === undefined ? {} : { status }),
      ...(order === undefined ? {} : { sortOrder: order }),
    });
  }
  @Permissions(PERMISSIONS.PROJECT_MANAGE)
  @Patch(':orderId/items/:itemId')
  updateItem(
    @Req() request: Authenticated,
    @Param('projectId') projectId: string,
    @Param('orderId') orderId: string,
    @Param('itemId') itemId: string,
    @Body() body: unknown,
  ) {
    assertAllowedFields(body, [
      'version',
      'name',
      'quantity',
      'unit',
      'plannedDate',
      'completedDate',
      'status',
      'sortOrder',
    ]);
    const unit = optionalString(body.unit, 'unit', 50);
    const plannedDate = optionalDate(body.plannedDate, 'plannedDate');
    const completedDate = optionalDate(body.completedDate, 'completedDate');
    const status = enumValue(body.status, ITEM_STATUSES, 'status');
    const order = sortOrder(body.sortOrder);
    return this.orders.updateItem(request.user.id, projectId, orderId, itemId, {
      version: requireVersion(body.version),
      ...(body.name === undefined ? {} : { name: requireString(body.name, 'name', 200) }),
      ...(body.quantity === undefined ? {} : { quantity: quantity(body.quantity) }),
      ...(unit === undefined ? {} : { unit }),
      ...(plannedDate === undefined ? {} : { plannedDate }),
      ...(completedDate === undefined ? {} : { completedDate }),
      ...(status === undefined ? {} : { status }),
      ...(order === undefined ? {} : { sortOrder: order }),
    });
  }
  @Permissions(PERMISSIONS.PROJECT_MANAGE)
  @Post(':orderId/items/:itemId/archive')
  archiveItem(
    @Req() request: Authenticated,
    @Param('projectId') projectId: string,
    @Param('orderId') orderId: string,
    @Param('itemId') itemId: string,
    @Body() body: unknown,
  ) {
    assertAllowedFields(body, ['version']);
    return this.orders.removeItem(
      request.user.id,
      projectId,
      orderId,
      itemId,
      requireVersion(body.version),
    );
  }
}
