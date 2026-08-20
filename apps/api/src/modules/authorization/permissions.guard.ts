import { ForbiddenException, Injectable, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { SessionGuard, type AuthenticatedRequest } from '../auth/session.guard';
import { SessionsService } from '../sessions/sessions.service';
import { RolesService } from '../roles/roles.service';
import { REQUIRED_PERMISSIONS } from './permissions.decorator';
import type { PermissionKey } from './permission.constants';

/**
 * System-level permission guard. Extends SessionGuard so authentication
 * (cookie token -> user) and the CSRF header check are performed exactly
 * once, then verifies the authenticated user holds every permission declared
 * by @Permissions(...) on the endpoint.
 *
 * Fail-closed semantics:
 *  - no/empty @Permissions declaration -> login-only (SessionGuard behaviour)
 *  - missing any required permission -> 403 Forbidden
 *  - the ADMIN role carries management permissions only; business data
 *    access is enforced separately via project scope (ProjectAccessService),
 *    so admin status never grants business reads.
 */
@Injectable()
export class PermissionsGuard extends SessionGuard {
  constructor(
    sessions: SessionsService,
    reflector: Reflector,
    private readonly roles: RolesService,
  ) {
    super(sessions, reflector);
  }

  override async canActivate(context: ExecutionContext): Promise<boolean> {
    await super.canActivate(context);

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const required =
      this.reflector.getAllAndOverride<PermissionKey[]>(REQUIRED_PERMISSIONS, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];
    if (required.length === 0) {
      return true;
    }

    const granted = new Set(await this.roles.listUserPermissions(request.user.id));
    const missing = required.filter((key) => !granted.has(key));
    if (missing.length > 0) {
      throw new ForbiddenException('没有执行此操作的权限');
    }
    return true;
  }
}
