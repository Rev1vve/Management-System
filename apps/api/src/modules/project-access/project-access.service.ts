import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../../database/prisma.service';
import type { ProjectRole } from '../../generated/prisma/client';

/**
 * Project-scope access kernel (plan task 6).
 *
 * Business data access flows through project membership, never through the
 * ADMIN system role. Every business service must call one of these primitives
 * before reading/writing project-scoped resources; guarding only at the HTTP
 * layer would leave horizontal-privilege holes.
 *
 * Anti-enumeration semantics: `assertProjectAccess` throws NotFoundException
 * for BOTH "project does not exist" and "user is not a member", so callers
 * cannot probe the existence of projects they may not see. Role-level denials
 * (member but insufficient project role) throw ForbiddenException.
 */
@Injectable()
export class ProjectAccessService {
  constructor(private readonly prisma: PrismaService) {}

  /** Whether the user holds any membership for the project. */
  async isProjectMember(userId: string, projectId: string): Promise<boolean> {
    const membership = await this.prisma.projectMembership.findUnique({
      where: { userId_projectId: { userId, projectId } },
      select: { id: true },
    });
    return membership !== null;
  }

  /** Project roles the user holds (empty when not a member). */
  async listProjectRoles(userId: string, projectId: string): Promise<ProjectRole[]> {
    const membership = await this.prisma.projectMembership.findUnique({
      where: { userId_projectId: { userId, projectId } },
      include: { roles: true },
    });
    return (membership?.roles ?? []).map((r) => r.role);
  }

  /**
   * Enforces project access with anti-enumeration semantics (404 for both
   * missing project and non-membership). Resolves the caller's project roles.
   */
  async assertProjectAccess(userId: string, projectId: string): Promise<{ roles: ProjectRole[] }> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true },
    });
    if (!project) {
      throw new NotFoundException('项目不存在');
    }

    const membership = await this.prisma.projectMembership.findUnique({
      where: { userId_projectId: { userId, projectId } },
      include: { roles: true },
    });
    if (!membership) {
      // Same response as a missing project: existence must not leak.
      throw new NotFoundException('项目不存在');
    }

    return { roles: membership.roles.map((r) => r.role) };
  }

  /**
   * Requires the user to hold at least one of the given project roles.
   * Non-members are rejected by assertProjectAccess (404, anti-enumeration);
   * members lacking every required role get a 403.
   */
  async assertProjectRole(
    userId: string,
    projectId: string,
    required: ProjectRole[],
  ): Promise<void> {
    const { roles } = await this.assertProjectAccess(userId, projectId);
    const granted = new Set<ProjectRole>(roles);
    if (!required.some((role) => granted.has(role))) {
      throw new ForbiddenException('没有此项目的操作权限');
    }
  }

  /** Project ids the user can access; used by services for scope filtering. */
  async resolveProjectScope(userId: string): Promise<string[]> {
    const memberships = await this.prisma.projectMembership.findMany({
      where: { userId },
      select: { projectId: true },
    });
    return memberships.map((m) => m.projectId);
  }
}
