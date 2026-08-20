import { Module } from '@nestjs/common';

import { InvitationsService } from './invitations.service';
import { InvitationsController } from './invitations.controller';
import { AuthModule } from '../auth/auth.module';
import { PasswordHashService } from '../../crypto/password-hash.service';

@Module({
  // AuthModule provides SessionGuard (used by the admin invitation
  // endpoint) and its SessionsService dependency in this module's context.
  imports: [AuthModule],
  controllers: [InvitationsController],
  providers: [InvitationsService, PasswordHashService],
  exports: [InvitationsService],
})
export class UsersModule {}
