import { Module } from '@nestjs/common';

import { RolesService } from './roles.service';

/**
 * Provides RolesService (effective permission resolution). Imported by
 * AuthorizationModule (PermissionsGuard) and any module that needs to
 * reason about system-level capabilities.
 */
@Module({
  providers: [RolesService],
  exports: [RolesService],
})
export class RolesModule {}
