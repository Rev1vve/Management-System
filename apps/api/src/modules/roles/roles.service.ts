import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../database/prisma.service';
import type { PermissionKey } from '../authorization/permission.constants';

/**
 * Resolves the effective permission set of a user.
 *
 * Semantics (plan task 6):
 *  - A user may hold several system roles (UserSystemRole join table); the
 *    effective permission set is the UNION of all their roles' permissions.
 *  - The matrix itself lives in the permissions / role_permissions tables
 *    (seeded from ROLE_DEFINITIONS), so it can evolve without code redeploys.
 *  - ADMIN grants management permissions only; business data access flows
 *    through project scope (ProjectAccessService), never through this set.
 */
@Injectable()
export class RolesService {
  constructor(private readonly prisma: PrismaService) {}

  /** De-duplicated permission keys granted through all system roles. */
  async listUserPermissions(userId: string): Promise<PermissionKey[]> {
    const memberships = await this.prisma.userSystemRole.findMany({
      where: { userId },
      select: {
        systemRole: {
          select: {
            rolePermissions: {
              select: {
                permission: {
                  select: { key: true },
                },
              },
            },
          },
        },
      },
    });

    const keys = new Set<PermissionKey>();
    for (const membership of memberships) {
      for (const rp of membership.systemRole.rolePermissions) {
        keys.add(rp.permission.key as PermissionKey);
      }
    }
    return [...keys];
  }
}
