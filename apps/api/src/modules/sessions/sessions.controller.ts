import { Controller, Delete, Get, Param, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';

import { SessionsService } from './sessions.service';
import { SessionGuard } from '../auth/session.guard';

/**
 * Session management for the current user: list active sessions (excluding
 * revoked), revoke a single session or revoke all (log out everywhere).
 */
@UseGuards(SessionGuard)
@Controller('sessions')
export class SessionsController {
  constructor(private readonly sessions: SessionsService) {}

  @Get()
  async list(@Req() req: Request) {
    const { user } = req as unknown as { user: { id: string } };
    const rows = await this.sessions.listActive(user.id);
    return rows.map((s) => ({
      id: s.id,
      deviceInfo: s.deviceInfo,
      createdAt: s.createdAt,
      lastUsedAt: s.lastUsedAt,
      expiresAt: s.expiresAt,
    }));
  }

  @Delete(':id')
  async revokeOne(@Req() req: Request, @Param('id') id: string) {
    const { user } = req as unknown as { user: { id: string } };
    await this.sessions.revokeById(user.id, id);
    return { ok: true };
  }

  @Delete()
  async revokeAll(@Req() req: Request) {
    const { user } = req as unknown as { user: { id: string } };
    await this.sessions.revokeAll(user.id);
    return { ok: true };
  }
}
