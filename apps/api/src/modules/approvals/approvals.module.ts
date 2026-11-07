import { Module } from '@nestjs/common';

import { AuthorizationModule } from '../authorization/authorization.module';
import { ProjectAccessModule } from '../project-access/project-access.module';
import { ApprovalsController } from './approvals.controller';
import { ApprovalsService } from './approvals.service';

@Module({
  imports: [AuthorizationModule, ProjectAccessModule],
  controllers: [ApprovalsController],
  providers: [ApprovalsService],
  exports: [ApprovalsService],
})
export class ApprovalsModule {}
