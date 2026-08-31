import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from '../../database/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import { PERMISSIONS } from '../authorization/permission.constants';
import { ProjectAccessService } from '../project-access/project-access.service';
import { RolesService } from '../roles/roles.service';

export interface ProjectListQuery {
  page: number;
  pageSize: number;
  search?: string;
  status?: string;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface CreateProjectInput {
  number: string;
  name: string;
  customerId?: string | null;
  portfolioId?: string | null;
  description?: string | null;
  startDate?: Date | null;
  endDate?: Date | null;
}

const PROJECT_SELECT = {
  id: true,
  number: true,
  name: true,
  description: true,
  startDate: true,
  endDate: true,
  status: true,
  completionPercent: true,
  version: true,
  updatedAt: true,
  customer: {
    select: { id: true, number: true, name: true, status: true, deletedAt: true },
  },
  portfolio: { select: { id: true, name: true, status: true, deletedAt: true } },
} as const;

type ProjectResult = Prisma.ProjectGetPayload<{ select: typeof PROJECT_SELECT }>;

function publicProject(project: ProjectResult) {
  const { customer, portfolio, ...fields } = project;
  return {
    ...fields,
    ...(customer === undefined
      ? {}
      : {
          customer:
            customer?.status !== 'ARCHIVED' && customer?.deletedAt === null
              ? { id: customer.id, number: customer.number, name: customer.name }
              : null,
        }),
    ...(portfolio === undefined
      ? {}
      : {
          portfolio:
            portfolio?.status !== 'ARCHIVED' && portfolio?.deletedAt === null
              ? { id: portfolio.id, name: portfolio.name }
              : null,
        }),
  };
}

const PROJECT_CREATE_FIELDS = new Set([
  'number',
  'name',
  'customerId',
  'portfolioId',
  'description',
  'startDate',
  'endDate',
]);
const PROJECT_UPDATE_FIELDS = new Set([
  ...PROJECT_CREATE_FIELDS,
  'status',
  'completionPercent',
  'version',
]);
const PROJECT_ROLES = new Set(['PROJECT_MANAGER', 'MEMBER', 'APPROVER', 'OBSERVER']);
const SERIALIZABLE_TRANSACTION_ATTEMPTS = 3;

function assertAllowedFields(input: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new BadRequestException(`不支持的字段：${unknown.join(', ')}`);
}

function assertProjectRoles(roles: string[]): void {
  if (
    roles.length === 0 ||
    new Set(roles).size !== roles.length ||
    roles.some((role) => !PROJECT_ROLES.has(role))
  ) {
    throw new BadRequestException('项目角色非法');
  }
}

@Injectable()
export class ProjectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projectAccess: ProjectAccessService,
    private readonly roles: RolesService,
  ) {}

  private currentManagerMembership(userId: string) {
    return {
      userId,
      roles: { some: { role: 'PROJECT_MANAGER' as const } },
      user: {
        status: 'ACTIVE' as const,
        deletedAt: null,
        systemRoles: {
          some: {
            systemRole: {
              rolePermissions: {
                some: { permission: { key: PERMISSIONS.PROJECT_MANAGE } },
              },
            },
          },
        },
      },
    };
  }

  private currentActiveMembership(userId: string) {
    return {
      userId,
      user: { status: 'ACTIVE' as const, deletedAt: null },
    };
  }

  async create(userId: string, input: CreateProjectInput) {
    assertAllowedFields(input as unknown as Record<string, unknown>, PROJECT_CREATE_FIELDS);
    await this.assertSystemManage(userId);
    await this.assertReferencesInScope(userId, input.customerId, input.portfolioId);
    return this.withSerializableRetry(async (tx) => {
      await this.assertCurrentSystemManage(tx, userId);
      await this.assertReferencesInScope(userId, input.customerId, input.portfolioId, tx);
      const project = await tx.project.create({ data: input, select: PROJECT_SELECT });
      await tx.projectMembership.create({
        data: {
          userId,
          projectId: project.id,
          roles: { create: [{ role: 'PROJECT_MANAGER' }] },
        },
      });
      return publicProject(project);
    });
  }

  async get(userId: string, projectId: string) {
    const access = await this.projectAccess.assertProjectAccess(userId, projectId);
    const project = await this.prisma.project.findFirst({
      where: {
        id: projectId,
        status: { not: 'ARCHIVED' },
        deletedAt: null,
        memberships: { some: { userId, user: { status: 'ACTIVE', deletedAt: null } } },
      },
      select: PROJECT_SELECT,
    });
    if (!project) throw new NotFoundException('项目不存在');
    const result = publicProject(project);
    if (
      access.roles.includes('PROJECT_MANAGER') &&
      (await this.roles.listUserPermissions(userId)).includes(PERMISSIONS.PROJECT_MANAGE)
    ) {
      return { ...result, canManage: true };
    }
    return result;
  }

  async list(userId: string, query: ProjectListQuery) {
    const projectIds = await this.projectAccess.resolveProjectScope(userId);
    // Collection capability controls creation only. Per-resource write capability
    // remains on get(), where project membership role is checked explicitly.
    const canManage = (await this.roles.listUserPermissions(userId)).includes(
      PERMISSIONS.PROJECT_MANAGE,
    );
    const where = {
      id: { in: projectIds },
      deletedAt: null,
      memberships: {
        some: { userId, user: { status: 'ACTIVE' as const, deletedAt: null } },
      },
      AND: [
        { status: { not: 'ARCHIVED' as const } },
        ...(query.status ? [{ status: query.status as never }] : []),
      ],
      ...(query.search
        ? {
            OR: [
              { number: { contains: query.search, mode: 'insensitive' as const } },
              { name: { contains: query.search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };
    const sortBy = query.sortBy ?? 'updatedAt';
    const sortOrder = query.sortOrder ?? 'desc';
    const [total, items] = await Promise.all([
      this.prisma.project.count({ where }),
      this.prisma.project.findMany({
        where,
        select: PROJECT_SELECT,
        orderBy: [{ [sortBy]: sortOrder }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);
    return {
      items: items.map(publicProject),
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / query.pageSize),
      canManage,
    };
  }

  async update(
    userId: string,
    projectId: string,
    input: Record<string, unknown> & { version: number },
  ) {
    assertAllowedFields(input, PROJECT_UPDATE_FIELDS);
    if (input.status === 'ARCHIVED') throw new BadRequestException('请使用项目归档操作');
    await this.assertSystemManage(userId);
    await this.projectAccess.assertProjectRole(userId, projectId, ['PROJECT_MANAGER']);
    const existing = await this.prisma.project.findFirst({
      where: { id: projectId, status: { not: 'ARCHIVED' }, deletedAt: null },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('项目不存在');
    const { version, ...data } = input;
    return this.withSerializableRetry(async (tx) => {
      const current =
        (await tx.project.findFirst({
          where: {
            id: projectId,
            status: { not: 'ARCHIVED' },
            deletedAt: null,
            memberships: { some: this.currentManagerMembership(userId) },
          },
          select: { customerId: true, portfolioId: true },
        })) ?? (await this.classifyMutationFailure(userId, projectId, tx));
      await this.assertReferencesInScope(
        userId,
        Object.hasOwn(data, 'customerId') ? (data.customerId as string | null) : current.customerId,
        Object.hasOwn(data, 'portfolioId')
          ? (data.portfolioId as string | null)
          : current.portfolioId,
        tx,
      );
      const result = await tx.project.updateMany({
        where: {
          id: projectId,
          version,
          status: { not: 'ARCHIVED' },
          deletedAt: null,
          memberships: { some: this.currentManagerMembership(userId) },
        },
        data: { ...data, version: { increment: 1 } },
      });
      if (result.count !== 1) await this.classifyMutationFailure(userId, projectId, tx);
      const project = await tx.project.findFirst({
        where: {
          id: projectId,
          status: { not: 'ARCHIVED' },
          deletedAt: null,
          memberships: { some: this.currentActiveMembership(userId) },
        },
        select: PROJECT_SELECT,
      });
      if (!project) throw new NotFoundException('项目不存在');
      return publicProject(project);
    });
  }

  async archive(userId: string, projectId: string, version: number) {
    await this.assertSystemManage(userId);
    await this.projectAccess.assertProjectRole(userId, projectId, ['PROJECT_MANAGER']);
    const existing = await this.prisma.project.findFirst({
      where: { id: projectId, status: { not: 'ARCHIVED' }, deletedAt: null },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('项目不存在');
    const result = await this.prisma.project.updateMany({
      where: {
        id: projectId,
        version,
        status: { not: 'ARCHIVED' },
        deletedAt: null,
        memberships: { some: this.currentManagerMembership(userId) },
      },
      data: { status: 'ARCHIVED', deletedAt: new Date(), version: { increment: 1 } },
    });
    if (result.count !== 1) await this.classifyMutationFailure(userId, projectId);
    return { ok: true };
  }

  async listMembers(userId: string, projectId: string) {
    await this.projectAccess.assertProjectAccess(userId, projectId);
    const project = await this.prisma.project.findFirst({
      where: {
        id: projectId,
        status: { not: 'ARCHIVED' },
        deletedAt: null,
        memberships: {
          some: { userId, user: { status: 'ACTIVE', deletedAt: null } },
        },
      },
      select: {
        memberships: {
          select: {
            id: true,
            userId: true,
            user: { select: { id: true, name: true, workEmail: true } },
            roles: { select: { role: true } },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!project) throw new NotFoundException('项目不存在');
    return project.memberships;
  }

  async addMember(userId: string, projectId: string, memberId: string, roles: string[]) {
    assertProjectRoles(roles);
    await this.assertSystemManage(userId);
    await this.projectAccess.assertProjectRole(userId, projectId, ['PROJECT_MANAGER']);
    return this.withSerializableRetry(async (tx) => {
      await this.assertCurrentManager(tx, userId, projectId);
      return tx.projectMembership.create({
        data: {
          userId: memberId,
          projectId,
          roles: { create: roles.map((role) => ({ role: role as never })) },
        },
        select: { id: true, userId: true, roles: { select: { role: true } } },
      });
    });
  }

  async replaceMemberRoles(userId: string, projectId: string, memberId: string, roles: string[]) {
    assertProjectRoles(roles);
    await this.assertSystemManage(userId);
    await this.projectAccess.assertProjectRole(userId, projectId, ['PROJECT_MANAGER']);
    return this.withSerializableRetry(async (tx) => {
      await this.assertCurrentManager(tx, userId, projectId);
      const membership = await tx.projectMembership.findUnique({
        where: { userId_projectId: { userId: memberId, projectId } },
        include: { roles: true },
      });
      if (!membership) throw new NotFoundException('项目成员不存在');
      const removesManager =
        membership.roles.some((entry) => entry.role === 'PROJECT_MANAGER') &&
        !roles.includes('PROJECT_MANAGER');
      if (removesManager) await this.assertNotLastManager(tx, projectId);
      await tx.projectMembershipRole.deleteMany({ where: { membershipId: membership.id } });
      await tx.projectMembershipRole.createMany({
        data: roles.map((role) => ({ membershipId: membership.id, role: role as never })),
      });
      return { id: membership.id, userId: memberId, roles };
    });
  }

  async removeMember(userId: string, projectId: string, memberId: string) {
    await this.assertSystemManage(userId);
    await this.projectAccess.assertProjectRole(userId, projectId, ['PROJECT_MANAGER']);
    await this.withSerializableRetry(async (tx) => {
      await this.assertCurrentManager(tx, userId, projectId);
      const membership = await tx.projectMembership.findUnique({
        where: { userId_projectId: { userId: memberId, projectId } },
        include: { roles: true },
      });
      if (!membership) throw new NotFoundException('项目成员不存在');
      if (membership.roles.some((entry) => entry.role === 'PROJECT_MANAGER'))
        await this.assertNotLastManager(tx, projectId);
      await tx.projectMembershipRole.deleteMany({ where: { membershipId: membership.id } });
      await tx.projectMembership.delete({ where: { id: membership.id } });
    });
    return { ok: true };
  }

  private async withSerializableRetry<T>(
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; attempt < SERIALIZABLE_TRANSACTION_ATTEMPTS; attempt += 1) {
      try {
        return await this.prisma.$transaction(work, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        const isWriteConflict =
          typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2034';
        if (!isWriteConflict) throw error;
        if (attempt === SERIALIZABLE_TRANSACTION_ATTEMPTS - 1) {
          throw new ConflictException('项目已被其他用户修改');
        }
      }
    }
    throw new Error('unreachable');
  }

  private async assertNotLastManager(tx: Prisma.TransactionClient, projectId: string) {
    const count = await tx.projectMembership.count({
      where: {
        projectId,
        roles: { some: { role: 'PROJECT_MANAGER' } },
        user: {
          status: 'ACTIVE',
          deletedAt: null,
          systemRoles: {
            some: {
              systemRole: {
                rolePermissions: {
                  some: { permission: { key: PERMISSIONS.PROJECT_MANAGE } },
                },
              },
            },
          },
        },
      },
    });
    if (count <= 1) throw new ConflictException('不能移除最后一个项目经理');
  }

  private async assertCurrentManager(
    tx: Prisma.TransactionClient,
    userId: string,
    projectId: string,
  ): Promise<void> {
    const current = await tx.projectMembership.findFirst({
      where: {
        ...this.currentManagerMembership(userId),
        projectId,
        project: { status: { not: 'ARCHIVED' }, deletedAt: null },
      },
      select: { id: true },
    });
    if (current) return;
    const visible = await tx.projectMembership.findFirst({
      where: {
        ...this.currentActiveMembership(userId),
        projectId,
        project: { status: { not: 'ARCHIVED' }, deletedAt: null },
      },
      select: { id: true },
    });
    if (!visible) throw new NotFoundException('项目不存在');
    throw new ForbiddenException('没有此项目的操作权限');
  }

  private async classifyMutationFailure(
    userId: string,
    projectId: string,
    db: Pick<Prisma.TransactionClient, 'project'> = this.prisma,
  ): Promise<never> {
    const current = await db.project.findFirst({
      where: {
        id: projectId,
        status: { not: 'ARCHIVED' },
        deletedAt: null,
        memberships: { some: this.currentManagerMembership(userId) },
      },
      select: { id: true },
    });
    if (current) throw new ConflictException('项目已被其他用户修改');
    const visible = await db.project.findFirst({
      where: {
        id: projectId,
        status: { not: 'ARCHIVED' },
        deletedAt: null,
        memberships: { some: this.currentActiveMembership(userId) },
      },
      select: { id: true },
    });
    if (!visible) throw new NotFoundException('项目不存在');
    throw new ForbiddenException('没有此项目的操作权限');
  }

  private async assertSystemManage(userId: string): Promise<void> {
    const permissions = await this.roles.listUserPermissions(userId);
    if (!permissions.includes(PERMISSIONS.PROJECT_MANAGE)) {
      throw new ForbiddenException('缺少项目维护权限');
    }
  }

  private async assertCurrentSystemManage(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<void> {
    const user = await tx.user.findFirst({
      where: {
        id: userId,
        status: 'ACTIVE',
        deletedAt: null,
        systemRoles: {
          some: {
            systemRole: {
              rolePermissions: {
                some: { permission: { key: PERMISSIONS.PROJECT_MANAGE } },
              },
            },
          },
        },
      },
      select: { id: true },
    });
    if (!user) throw new ForbiddenException('缺少项目维护权限');
  }

  private async assertReferencesInScope(
    userId: string,
    customerId: string | null | undefined,
    portfolioId: string | null | undefined,
    db: Pick<Prisma.TransactionClient, 'customer' | 'portfolio'> = this.prisma,
  ): Promise<void> {
    if (customerId) {
      const customer = await db.customer.findFirst({
        where: {
          id: customerId,
          status: { not: 'ARCHIVED' },
          deletedAt: null,
          projects: {
            some: {
              status: { not: 'ARCHIVED' },
              deletedAt: null,
              memberships: { some: { userId } },
            },
          },
        },
        select: { id: true },
      });
      if (!customer) throw new NotFoundException('客户不存在');
    }
    if (portfolioId) {
      const portfolio = await db.portfolio.findFirst({
        where: {
          id: portfolioId,
          status: { not: 'ARCHIVED' },
          deletedAt: null,
          memberships: { some: { userId } },
        },
        select: { id: true },
      });
      if (!portfolio) throw new NotFoundException('项目集不存在');
    }
  }
}
