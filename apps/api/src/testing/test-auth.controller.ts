import { Controller, Get, Post, UseGuards } from '@nestjs/common';

import { PermissionsGuard } from '../modules/authorization/permissions.guard';
import { Permissions } from '../modules/authorization/permissions.decorator';
import { PERMISSIONS } from '../modules/authorization/permission.constants';

/**
 * Permission-matrix test fixture (plan task 6): a minimal controller that
 * exercises PermissionsGuard over the real HTTP + session-cookie chain.
 *
 * Lives under src/ (and is excluded from the build) on purpose: vitest runs
 * files outside the tsconfig.json include set through Node's native
 * type-stripping, which does not support decorators; files under src/ are
 * transformed by the esbuild pipeline where decorators are fine.
 */
@Controller('test-auth')
export class TestAuthController {
  @UseGuards(PermissionsGuard)
  @Permissions(PERMISSIONS.AUDIT_VIEW)
  @Get('audit')
  audit() {
    return { ok: true };
  }

  @UseGuards(PermissionsGuard)
  @Permissions(PERMISSIONS.USER_INVITE, PERMISSIONS.AUDIT_VIEW)
  @Get('both')
  both() {
    return { ok: true };
  }

  // ADMIN must NOT hold this: business data access never comes from admin.
  @UseGuards(PermissionsGuard)
  @Permissions(PERMISSIONS.PROJECT_VIEW)
  @Get('project-view')
  projectView() {
    return { ok: true };
  }

  // Requires one key from APPROVER and one from PROJECT_MANAGER: exercises
  // multi-role union semantics.
  @UseGuards(PermissionsGuard)
  @Permissions(PERMISSIONS.APPROVAL_DECIDE, PERMISSIONS.PROJECT_MANAGE)
  @Get('merged')
  merged() {
    return { ok: true };
  }

  @UseGuards(PermissionsGuard)
  @Get('login-only')
  loginOnly() {
    return { ok: true };
  }

  // Mutating endpoint: exercises the CSRF-header requirement on POST (the
  // SessionGuard base rejects missing x-requested-with with 401 before any
  // permission check runs).
  @UseGuards(PermissionsGuard)
  @Permissions(PERMISSIONS.AUDIT_VIEW)
  @Post('audit')
  postAudit() {
    return { ok: true };
  }
}
