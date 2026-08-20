import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { ProjectAccessService } from './project-access.service';
import { PrismaService } from '../../database/prisma.service';

/**
 * Unit tests for ProjectAccessService primitives. Anti-enumeration semantics
 * (404 for both missing project and non-membership) are the core contract
 * exercised here; the DB-backed integration behaviour is covered by the
 * project-access integration spec.
 */
function makeService(overrides: {
  project?: unknown;
  membership?: unknown;
  memberships?: unknown[];
}): ProjectAccessService {
  const prisma = {
    project: { findUnique: vi.fn(async () => overrides.project ?? null) },
    projectMembership: {
      findUnique: vi.fn(async () => overrides.membership ?? null),
      findMany: vi.fn(async () => overrides.memberships ?? []),
    },
  } as unknown as PrismaService;
  return new ProjectAccessService(prisma);
}

describe('ProjectAccessService.isProjectMember', () => {
  it('returns true for an existing membership', async () => {
    const service = makeService({ membership: { id: 'm1' } });
    await expect(service.isProjectMember('u1', 'p1')).resolves.toBe(true);
  });

  it('returns false without a membership', async () => {
    const service = makeService({ membership: null });
    await expect(service.isProjectMember('u1', 'p1')).resolves.toBe(false);
  });
});

describe('ProjectAccessService.listProjectRoles', () => {
  it('returns the roles of an existing membership', async () => {
    const service = makeService({
      membership: {
        id: 'm1',
        roles: [{ role: 'MEMBER' }, { role: 'APPROVER' }],
      },
    });
    await expect(service.listProjectRoles('u1', 'p1')).resolves.toEqual(['MEMBER', 'APPROVER']);
  });

  it('returns [] for a non-member', async () => {
    const service = makeService({ membership: null });
    await expect(service.listProjectRoles('u1', 'p1')).resolves.toEqual([]);
  });
});

describe('ProjectAccessService.assertProjectAccess', () => {
  it('throws 404 when the project does not exist', async () => {
    const service = makeService({ project: null });
    await expect(service.assertProjectAccess('u1', 'missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('throws 404 for a non-member (same response as missing project)', async () => {
    const service = makeService({ project: { id: 'p1' }, membership: null });
    await expect(service.assertProjectAccess('u1', 'p1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('resolves roles for a member', async () => {
    const service = makeService({
      project: { id: 'p1' },
      membership: { id: 'm1', roles: [{ role: 'PROJECT_MANAGER' }] },
    });
    await expect(service.assertProjectAccess('u1', 'p1')).resolves.toEqual({
      roles: ['PROJECT_MANAGER'],
    });
  });
});

describe('ProjectAccessService.assertProjectRole', () => {
  it('allows when the user holds one of the required roles', async () => {
    const service = makeService({
      project: { id: 'p1' },
      membership: { id: 'm1', roles: [{ role: 'MEMBER' }] },
    });
    await expect(
      service.assertProjectRole('u1', 'p1', ['MEMBER', 'OBSERVER']),
    ).resolves.toBeUndefined();
  });

  it('throws 403 when the user is a member but lacks every required role', async () => {
    const service = makeService({
      project: { id: 'p1' },
      membership: { id: 'm1', roles: [{ role: 'MEMBER' }] },
    });
    await expect(service.assertProjectRole('u1', 'p1', ['PROJECT_MANAGER'])).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('throws 404 (not 403) for a non-member: role checks never leak existence', async () => {
    const service = makeService({ project: { id: 'p1' }, membership: null });
    await expect(service.assertProjectRole('u1', 'p1', ['MEMBER'])).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('ProjectAccessService.resolveProjectScope', () => {
  it('returns the project ids of all memberships', async () => {
    const service = makeService({
      memberships: [{ projectId: 'p1' }, { projectId: 'p2' }],
    });
    await expect(service.resolveProjectScope('u1')).resolves.toEqual(['p1', 'p2']);
  });

  it('returns [] for a user with no memberships', async () => {
    const service = makeService({ memberships: [] });
    await expect(service.resolveProjectScope('u1')).resolves.toEqual([]);
  });
});
