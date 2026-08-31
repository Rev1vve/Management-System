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

import { CustomersService } from './customers.service';
import { PermissionsGuard } from '../authorization/permissions.guard';
import { Permissions } from '../authorization/permissions.decorator';
import { PERMISSIONS } from '../authorization/permission.constants';
import {
  assertAllowedFields,
  optionalString,
  parseListQuery,
  requireString,
  requireVersion,
} from '../business-query';

const STATUSES = ['ACTIVE', 'INACTIVE', 'ARCHIVED'] as const;
const SORT_FIELDS = ['number', 'name', 'status', 'updatedAt'] as const;

type Authenticated = Request & { user: { id: string } };

@UseGuards(PermissionsGuard)
@Controller('customers')
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get()
  list(@Req() request: Authenticated, @Query() query: Record<string, unknown>) {
    return this.customers.list(
      request.user.id,
      parseListQuery(query, { statuses: STATUSES, sortFields: SORT_FIELDS }),
    );
  }

  @Get(':customerId')
  get(@Req() request: Authenticated, @Param('customerId') customerId: string) {
    return this.customers.get(request.user.id, customerId);
  }

  @Get(':customerId/contacts')
  listContacts(@Req() request: Authenticated, @Param('customerId') customerId: string) {
    return this.customers.listContacts(request.user.id, customerId);
  }

  @Permissions(PERMISSIONS.PROJECT_MANAGE)
  @Post()
  create(@Req() request: Authenticated, @Body() body: unknown) {
    assertAllowedFields(body, ['projectId', 'number', 'name', 'notes']);
    const notes = optionalString(body.notes, 'notes', 4000);
    return this.customers.create(request.user.id, {
      projectId: requireString(body.projectId, 'projectId', 100),
      number: requireString(body.number, 'number', 100),
      name: requireString(body.name, 'name', 200),
      ...(notes === undefined ? {} : { notes }),
    });
  }

  @Permissions(PERMISSIONS.PROJECT_MANAGE)
  @Patch(':customerId')
  update(
    @Req() request: Authenticated,
    @Param('customerId') customerId: string,
    @Body() body: unknown,
  ) {
    assertAllowedFields(body, ['number', 'name', 'status', 'notes', 'version']);
    const status = body.status;
    if (status !== undefined && !STATUSES.includes(status as (typeof STATUSES)[number])) {
      throw new BadRequestException('非法 status');
    }
    return this.customers.update(request.user.id, customerId, {
      version: requireVersion(body.version),
      ...(body.number === undefined ? {} : { number: requireString(body.number, 'number', 100) }),
      ...(body.name === undefined ? {} : { name: requireString(body.name, 'name', 200) }),
      ...(status === undefined ? {} : { status }),
      ...(body.notes === undefined ? {} : { notes: optionalString(body.notes, 'notes', 4000) }),
    });
  }

  @Permissions(PERMISSIONS.PROJECT_MANAGE)
  @Post(':customerId/archive')
  archive(
    @Req() request: Authenticated,
    @Param('customerId') customerId: string,
    @Body() body: unknown,
  ) {
    assertAllowedFields(body, ['version']);
    return this.customers.archive(request.user.id, customerId, requireVersion(body.version));
  }

  @Permissions(PERMISSIONS.PROJECT_MANAGE)
  @Post(':customerId/contacts')
  createContact(
    @Req() request: Authenticated,
    @Param('customerId') customerId: string,
    @Body() body: unknown,
  ) {
    assertAllowedFields(body, ['version', 'name', 'workEmail', 'phone', 'position', 'isPrimary']);
    return this.customers.createContact(request.user.id, customerId, {
      version: requireVersion(body.version),
      name: requireString(body.name, 'name', 200),
      ...(body.workEmail === undefined
        ? {}
        : { workEmail: optionalString(body.workEmail, 'workEmail', 320) }),
      ...(body.phone === undefined ? {} : { phone: optionalString(body.phone, 'phone', 100) }),
      ...(body.position === undefined
        ? {}
        : { position: optionalString(body.position, 'position', 200) }),
      ...(body.isPrimary === undefined
        ? {}
        : { isPrimary: this.requireBoolean(body.isPrimary, 'isPrimary') }),
    });
  }

  @Permissions(PERMISSIONS.PROJECT_MANAGE)
  @Patch(':customerId/contacts/:contactId')
  updateContact(
    @Req() request: Authenticated,
    @Param('customerId') customerId: string,
    @Param('contactId') contactId: string,
    @Body() body: unknown,
  ) {
    assertAllowedFields(body, ['version', 'name', 'workEmail', 'phone', 'position', 'isPrimary']);
    return this.customers.updateContact(request.user.id, customerId, contactId, {
      version: requireVersion(body.version),
      ...(body.name === undefined ? {} : { name: requireString(body.name, 'name', 200) }),
      ...(body.workEmail === undefined
        ? {}
        : { workEmail: optionalString(body.workEmail, 'workEmail', 320) }),
      ...(body.phone === undefined ? {} : { phone: optionalString(body.phone, 'phone', 100) }),
      ...(body.position === undefined
        ? {}
        : { position: optionalString(body.position, 'position', 200) }),
      ...(body.isPrimary === undefined
        ? {}
        : { isPrimary: this.requireBoolean(body.isPrimary, 'isPrimary') }),
    });
  }

  @Permissions(PERMISSIONS.PROJECT_MANAGE)
  @Post(':customerId/contacts/:contactId/archive')
  archiveContact(
    @Req() request: Authenticated,
    @Param('customerId') customerId: string,
    @Param('contactId') contactId: string,
    @Body() body: unknown,
  ) {
    assertAllowedFields(body, ['version']);
    return this.customers.archiveContact(
      request.user.id,
      customerId,
      contactId,
      requireVersion(body.version),
    );
  }

  private requireBoolean(value: unknown, field: string): boolean {
    if (typeof value !== 'boolean') throw new BadRequestException(`${field} 必须是布尔值`);
    return value;
  }
}
