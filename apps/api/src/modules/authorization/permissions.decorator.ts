import { SetMetadata } from '@nestjs/common';

import type { PermissionKey } from './permission.constants';

/** Metadata key holding the permission keys required by an endpoint. */
export const REQUIRED_PERMISSIONS = 'requiredPermissions';

/**
 * Declares the system-level permissions required to call the endpoint.
 * Multiple keys are AND-ed: the caller must hold ALL of them.
 *
 * When used together with PermissionsGuard, an endpoint without this
 * decorator is login-only (SessionGuard semantics); an endpoint with
 * @Permissions() (empty) is also login-only.
 *
 * Business-resource access (which project a user may touch) is enforced by
 * ProjectAccessService inside services, never by this decorator alone.
 */
export const Permissions = (...keys: PermissionKey[]): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRED_PERMISSIONS, keys);
