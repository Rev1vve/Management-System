import { Module } from '@nestjs/common';

import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { AuthorizationModule } from '../authorization/authorization.module';
import { ProjectAccessModule } from '../project-access/project-access.module';

@Module({
  imports: [AuthorizationModule, ProjectAccessModule],
  controllers: [ProjectsController],
  providers: [ProjectsService],
  exports: [ProjectsService],
})
export class ProjectsModule {}
