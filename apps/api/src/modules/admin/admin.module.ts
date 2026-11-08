import { Module } from '@nestjs/common';

import { AuthorizationModule } from '../authorization/authorization.module';
import { AdminAuditService } from './admin-audit.service';
import { AdminController } from './admin.controller';
import { AdminUsersService } from './admin-users.service';

@Module({
  imports: [AuthorizationModule],
  controllers: [AdminController],
  providers: [AdminUsersService, AdminAuditService],
})
export class AdminModule {}
