import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { RolesModule } from '../roles/roles.module';
import { PermissionsGuard } from './permissions.guard';

/**
 * Authorization kernel: PermissionsGuard (system-level capability checks)
 * backed by RolesService. Business-resource scoping lives in
 * ProjectAccessService (project-access module), which services combine with
 * these system-level checks.
 *
 * Forwards AuthModule and RolesModule: NestJS exports are not transitive and
 * a provider can only be re-exported by the module that declares it, so the
 * guard's dependency graph (SessionsService, RolesService) reaches consumers
 * by forwarding the source modules themselves.
 */
@Module({
  imports: [AuthModule, RolesModule],
  providers: [PermissionsGuard],
  exports: [PermissionsGuard, AuthModule, RolesModule],
})
export class AuthorizationModule {}
