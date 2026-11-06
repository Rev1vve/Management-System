import { Module } from '@nestjs/common';

import { AuthorizationModule } from '../authorization/authorization.module';
import { ProjectAccessModule } from '../project-access/project-access.module';
import { WorkLogsController } from './work-logs.controller';
import { WorkLogsService } from './work-logs.service';

@Module({
  imports: [AuthorizationModule, ProjectAccessModule],
  controllers: [WorkLogsController],
  providers: [WorkLogsService],
  exports: [WorkLogsService],
})
export class WorkLogsModule {}
