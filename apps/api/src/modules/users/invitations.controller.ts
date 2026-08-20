import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';

import { InvitationsService } from './invitations.service';
import { PermissionsGuard } from '../authorization/permissions.guard';
import { Permissions } from '../authorization/permissions.decorator';
import { PERMISSIONS } from '../authorization/permission.constants';

export interface CreateInvitationBody {
  email: string;
}

export interface AcceptInvitationBody {
  token: string;
  name: string;
  password: string;
}

/**
 * Invitation endpoints: public activation (single-use token + password setup)
 * and permission-gated creation. Creation requires the `user:invite` system
 * permission (granted to ADMIN by the seeded matrix); the PermissionsGuard
 * rejects callers without it with 403 before the service is reached.
 */
@Controller('invitations')
export class InvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  @Post('accept')
  async accept(@Body() body: AcceptInvitationBody) {
    const user = await this.invitations.acceptInvitation(body);
    return { ok: true, account: user.account };
  }

  @UseGuards(PermissionsGuard)
  @Permissions(PERMISSIONS.USER_INVITE)
  @Post()
  async create(@Req() req: Request, @Body() body: CreateInvitationBody) {
    const { user } = req as unknown as { user: { id: string } };
    const result = await this.invitations.createInvitation({
      actorId: user.id,
      email: body.email,
    });
    // The raw token is returned exactly once for development; in production
    // the activation link is delivered by the EmailOutbox worker.
    return { ok: true, invitationId: result.invitation.id, token: result.token };
  }
}
