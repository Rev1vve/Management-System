import { describe, expect, it, vi } from 'vitest';

import { RolesService } from './roles.service';
import { PrismaService } from '../../database/prisma.service';
import { PERMISSIONS } from '../authorization/permission.constants';

/**
 * Unit tests for RolesService.listUserPermissions: union semantics across
 * multiple system roles, de-duplication and empty results. The DB-backed
 * matrix behaviour itself is covered by the authorization integration spec.
 */
function makeService(findMany: (args: unknown) => Promise<unknown>): {
  service: RolesService;
  prisma: PrismaService;
} {
  const prisma = {
    userSystemRole: { findMany },
  } as unknown as PrismaService;
  return { service: new RolesService(prisma), prisma };
}

function membership(rolePermissions: Array<{ key: string }>): unknown {
  return {
    systemRole: {
      rolePermissions: rolePermissions.map((p) => ({
        permission: { key: p.key },
      })),
    },
  };
}

describe('RolesService.listUserPermissions', () => {
  it('returns the permissions of a single role', async () => {
    const { service } = makeService(async () => [
      membership([{ key: PERMISSIONS.USER_INVITE }, { key: PERMISSIONS.AUDIT_VIEW }]),
    ]);

    await expect(service.listUserPermissions('u1')).resolves.toEqual([
      PERMISSIONS.USER_INVITE,
      PERMISSIONS.AUDIT_VIEW,
    ]);
  });

  it('unions permissions across multiple roles (merge semantics)', async () => {
    const { service } = makeService(async () => [
      membership([{ key: PERMISSIONS.APPROVAL_DECIDE }]),
      membership([{ key: PERMISSIONS.PROJECT_MANAGE }, { key: PERMISSIONS.WORKLOG_MANAGE }]),
    ]);

    await expect(service.listUserPermissions('u2')).resolves.toEqual([
      PERMISSIONS.APPROVAL_DECIDE,
      PERMISSIONS.PROJECT_MANAGE,
      PERMISSIONS.WORKLOG_MANAGE,
    ]);
  });

  it('de-duplicates a key shared by two roles', async () => {
    const { service } = makeService(async () => [
      membership([{ key: PERMISSIONS.PROJECT_VIEW }]),
      membership([{ key: PERMISSIONS.PROJECT_VIEW }]),
    ]);

    const keys = await service.listUserPermissions('u3');
    expect(keys).toEqual([PERMISSIONS.PROJECT_VIEW]);
  });

  it('returns [] for a user with no system roles', async () => {
    const { service } = makeService(async () => []);

    await expect(service.listUserPermissions('u4')).resolves.toEqual([]);
  });

  it('returns [] for roles that grant no permissions (EMPLOYEE)', async () => {
    const { service } = makeService(async () => [membership([])]);

    await expect(service.listUserPermissions('u5')).resolves.toEqual([]);
  });

  it('filters by the requested user id', async () => {
    const findMany = vi.fn(async () => []);
    const { service } = makeService(findMany);

    await service.listUserPermissions('u6');
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'u6' } }));
  });
});
