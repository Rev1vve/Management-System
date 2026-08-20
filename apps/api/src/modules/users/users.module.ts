import { Module } from '@nestjs/common';

import { InvitationsService } from './invitations.service';
import { InvitationsController } from './invitations.controller';
import { AuthorizationModule } from '../authorization/authorization.module';
import { PasswordHashService } from '../../crypto/password-hash.service';

@Module({
  // AuthorizationModule provides PermissionsGuard (used by the admin
  // invitation endpoint); it pulls in AuthModule (SessionGuard base) and
  // RolesModule (permission resolution) internally.
  imports: [AuthorizationModule],
  controllers: [InvitationsController],
  providers: [InvitationsService, PasswordHashService],
  exports: [InvitationsService],
})
export class UsersModule {}
