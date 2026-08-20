import { Body, Controller, ForbiddenException, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';

import { InvitationsService } from './invitations.service';
import { SessionGuard } from '../auth/session.guard';

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
 * and admin creation. Admin creation requires an authenticated session whose
 * user holds the ADMIN system role (minimal gate; full permission kernel is
 * task 6).
 */
@Controller('invitations')
export class InvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  @Post('accept')
  async accept(@Body() body: AcceptInvitationBody) {
    const user = await this.invitations.acceptInvitation(body);
    return { ok: true, account: user.account };
  }

  @UseGuards(SessionGuard)
  @Post()
  async create(@Req() req: Request, @Body() body: CreateInvitationBody) {
    const { user } = req as unknown as { user: { id: string } };
    const isAdmin = await this.invitations.isAdmin(user.id);
    if (!isAdmin) {
      throw new ForbiddenException('只有管理员可以邀请用户');
    }
    const result = await this.invitations.createInvitation({
      actorId: user.id,
      email: body.email,
    });
    // The raw token is returned exactly once for development; in production
    // the activation link is delivered by the EmailOutbox worker.
    return { ok: true, invitationId: result.invitation.id, token: result.token };
  }
}
