import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';

import { PermissionsGuard } from './permissions.guard';
import { SessionsService } from '../sessions/sessions.service';
import { RolesService } from '../roles/roles.service';
import { PERMISSIONS } from './permission.constants';
import type { PermissionKey } from './permission.constants';

function makeGuard(options: {
  validate?: () => Promise<{ user: { id: string }; session: { id: string } }>;
  permissions?: PermissionKey[] | undefined;
  listUserPermissions?: PermissionKey[];
}): PermissionsGuard {
  const sessions = {
    validate: options.validate ?? (async () => ({ user: { id: 'u1' }, session: { id: 's1' } })),
  } as unknown as SessionsService;
  const reflector = {
    getAllAndOverride: () => options.permissions,
  } as unknown as Reflector;
  const roles = {
    listUserPermissions: async () => options.listUserPermissions ?? [],
  } as unknown as RolesService;
  return new PermissionsGuard(sessions, reflector, roles);
}

function makeContext(): { ctx: ExecutionContext; request: Record<string, unknown> } {
  const request: Record<string, unknown> = {
    cookies: { poc_session: 'tok' },
    method: 'GET',
    headers: {},
  };
  const ctx = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
  return { ctx, request };
}

describe('PermissionsGuard', () => {
  it('authenticates via the underlying session guard', async () => {
    const validate = vi.fn(async () => ({ user: { id: 'u1' }, session: { id: 's1' } }));
    const guard = makeGuard({ validate, permissions: undefined });
    const { ctx, request } = makeContext();

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(validate).toHaveBeenCalled();
    expect(request.user).toEqual({ id: 'u1' });
    expect(request.sessionId).toBe('s1');
  });

  it('allows a login-only endpoint (no @Permissions metadata)', async () => {
    const guard = makeGuard({ permissions: undefined });
    const { ctx } = makeContext();

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('allows a login-only endpoint (empty @Permissions)', async () => {
    const guard = makeGuard({ permissions: [] });
    const { ctx } = makeContext();

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('allows when the user holds every required permission', async () => {
    const guard = makeGuard({
      permissions: [PERMISSIONS.USER_INVITE, PERMISSIONS.AUDIT_VIEW],
      listUserPermissions: [
        PERMISSIONS.USER_INVITE,
        PERMISSIONS.AUDIT_VIEW,
        PERMISSIONS.SYSTEM_SETTINGS,
      ],
    });
    const { ctx } = makeContext();

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('rejects with 403 when the user lacks a required permission', async () => {
    const guard = makeGuard({
      permissions: [PERMISSIONS.AUDIT_VIEW],
      listUserPermissions: [PERMISSIONS.USER_INVITE],
    });
    const { ctx } = makeContext();

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('ANDs multiple required permissions (missing any one rejects)', async () => {
    const guard = makeGuard({
      permissions: [PERMISSIONS.USER_INVITE, PERMISSIONS.AUDIT_VIEW],
      listUserPermissions: [PERMISSIONS.USER_INVITE],
    });
    const { ctx } = makeContext();

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects with 403 when the user has no system permissions', async () => {
    const guard = makeGuard({
      permissions: [PERMISSIONS.USER_INVITE],
      listUserPermissions: [],
    });
    const { ctx } = makeContext();

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
