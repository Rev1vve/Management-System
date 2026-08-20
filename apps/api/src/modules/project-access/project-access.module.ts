import { Module } from '@nestjs/common';

import { ProjectAccessService } from './project-access.service';

/**
 * Provides ProjectAccessService (project-scope enforcement primitives).
 * Business modules import this and combine scope assertions with the
 * system-level PermissionsGuard.
 */
@Module({
  providers: [ProjectAccessService],
  exports: [ProjectAccessService],
})
export class ProjectAccessModule {}
