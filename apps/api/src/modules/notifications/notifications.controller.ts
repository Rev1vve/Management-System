import { Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';

import { PermissionsGuard } from '../authorization/permissions.guard';
import { NotificationsService } from './notifications.service';

type Authenticated = Request & { user: { id: string } };

@UseGuards(PermissionsGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(@Req() request: Authenticated, @Query() query: Record<string, unknown>) {
    return this.notifications.list(request.user.id, {
      page: Number(query.page ?? 1),
      pageSize: Number(query.pageSize ?? 20),
      unreadOnly: query.unread === 'true' || query.unread === '1',
    });
  }

  @Post(':id/read')
  markRead(@Req() request: Authenticated, @Param('id') id: string) {
    return this.notifications.markRead(request.user.id, id);
  }
}
