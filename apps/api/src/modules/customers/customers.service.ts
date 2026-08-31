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

export interface CustomerListQuery {
  page: number;
  pageSize: number;
  search?: string;
  status?: string;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

const CUSTOMER_BASE_SELECT = {
  id: true,
  number: true,
  name: true,
  status: true,
  version: true,
  updatedAt: true,
} as const;

const CUSTOMER_SENSITIVE_SELECT = {
  ...CUSTOMER_BASE_SELECT,
  notes: true,
  contacts: {
    where: { archivedAt: null },
    select: {
      id: true,
      customerId: true,
      name: true,
      workEmail: true,
      phone: true,
      position: true,
      isPrimary: true,
    },
  },
} as const;

const CUSTOMER_UPDATE_FIELDS = new Set(['number', 'name', 'status', 'notes', 'version']);
const CONTACT_WRITE_FIELDS = new Set([
  'name',
  'workEmail',
  'phone',
  'position',
  'isPrimary',
  'version',
]);
const CONTACT_PUBLIC_SELECT = {
  id: true,
  customerId: true,
  name: true,
  workEmail: true,
  phone: true,
  position: true,
  isPrimary: true,
  createdAt: true,
  updatedAt: true,
} as const;
const SERIALIZABLE_TRANSACTION_ATTEMPTS = 3;

function assertAllowedCustomerUpdate(input: Record<string, unknown>): void {
  const unknown = Object.keys(input).filter((key) => !CUSTOMER_UPDATE_FIELDS.has(key));
  if (unknown.length > 0) throw new BadRequestException(`不支持的字段：${unknown.join(', ')}`);
  if (input.status === 'ARCHIVED') throw new BadRequestException('请使用客户归档操作');
}

function assertAllowedContactWrite(input: Record<string, unknown>): void {
  const unknown = Object.keys(input).filter((key) => !CONTACT_WRITE_FIELDS.has(key));
  if (unknown.length > 0) throw new BadRequestException(`不支持的字段：${unknown.join(', ')}`);
}

@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projectAccess: ProjectAccessService,
    private readonly roles: RolesService,
  ) {}

  private currentVisibleProject(userId: string, projectIds?: string[]) {
    return {
      ...(projectIds ? { id: { in: projectIds } } : {}),
      status: { not: 'ARCHIVED' as const },
      deletedAt: null,
      memberships: {
        some: {
          userId,
          user: { status: 'ACTIVE' as const, deletedAt: null },
        },
      },
    };
  }

  private currentSensitiveProject(userId: string, managedProjectIds?: string[]) {
    return {
      ...(managedProjectIds ? { id: { in: managedProjectIds } } : {}),
      status: 'ACTIVE' as const,
      deletedAt: null,
      memberships: {
        some: {
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
        },
      },
    };
  }

  private async scopes(userId: string) {
    const projectIds = await this.projectAccess.resolveProjectScope(userId);
    const managedProjectIds: string[] = [];
    for (const projectId of projectIds) {
      const roles = await this.projectAccess.listProjectRoles(userId, projectId);
      if (roles.includes('PROJECT_MANAGER')) managedProjectIds.push(projectId);
    }
    return { projectIds, managedProjectIds };
  }

  async list(userId: string, query: CustomerListQuery) {
    const { projectIds, managedProjectIds } = await this.scopes(userId);
    const canManage =
      managedProjectIds.length > 0 &&
      (await this.roles.listUserPermissions(userId)).includes(PERMISSIONS.PROJECT_MANAGE);
    const where: Prisma.CustomerWhereInput = {
      deletedAt: null,
      AND: [
        { status: { not: 'ARCHIVED' as const } },
        ...(query.status ? [{ status: query.status as never }] : []),
      ],
      projects: { some: this.currentVisibleProject(userId, projectIds) },
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
    const [total, baseItems] = await Promise.all([
      this.prisma.customer.count({ where }),
      this.prisma.customer.findMany({
        where,
        select: CUSTOMER_BASE_SELECT,
        orderBy: [{ [sortBy]: sortOrder }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);

    if (!canManage || baseItems.length === 0) {
      return {
        items: baseItems,
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: total === 0 ? 0 : Math.ceil(total / query.pageSize),
        canManage,
      };
    }
    const managed = await this.prisma.customer.findMany({
      where: {
        id: { in: baseItems.map((item) => item.id) },
        status: { not: 'ARCHIVED' },
        deletedAt: null,
        projects: { some: this.currentSensitiveProject(userId, managedProjectIds) },
      },
      select: CUSTOMER_SENSITIVE_SELECT,
    });
    const sensitiveById = new Map(managed.map((item) => [item.id, item]));
    const items = baseItems.map((item) => sensitiveById.get(item.id) ?? item);
    return {
      items,
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / query.pageSize),
      canManage,
    };
  }

  async get(userId: string, customerId: string) {
    const { projectIds, managedProjectIds } = await this.scopes(userId);
    const base = await this.prisma.customer.findFirst({
      where: {
        id: customerId,
        status: { not: 'ARCHIVED' },
        deletedAt: null,
        projects: { some: this.currentVisibleProject(userId, projectIds) },
      },
      select: CUSTOMER_BASE_SELECT,
    });
    if (!base) throw new NotFoundException('客户不存在');
    if (managedProjectIds.length === 0) return base;
    if (!(await this.roles.listUserPermissions(userId)).includes(PERMISSIONS.PROJECT_MANAGE))
      return base;
    const managed = await this.prisma.customer.findFirst({
      where: {
        id: customerId,
        status: { not: 'ARCHIVED' },
        deletedAt: null,
        projects: { some: this.currentSensitiveProject(userId, managedProjectIds) },
      },
      select: CUSTOMER_SENSITIVE_SELECT,
    });
    if (!managed) return base;
    return { ...managed, canManage: true };
  }

  async create(
    userId: string,
    input: { projectId: string; number: string; name: string; notes?: string | null },
  ) {
    await this.assertSystemManage(userId);
    await this.projectAccess.assertProjectRole(userId, input.projectId, ['PROJECT_MANAGER']);
    const { projectId, ...customerData } = input;
    return this.prisma.$transaction(async (tx) => {
      const customer = await tx.customer.create({
        data: customerData,
        select: CUSTOMER_SENSITIVE_SELECT,
      });
      const bound = await tx.project.updateMany({
        where: {
          id: projectId,
          customerId: null,
          ...this.currentSensitiveProject(userId),
        },
        data: { customerId: customer.id },
      });
      if (bound.count !== 1) {
        const current = await tx.project.findFirst({
          where: { id: projectId, ...this.currentSensitiveProject(userId) },
          select: { id: true },
        });
        if (current) throw new ConflictException('项目已关联客户');
        const visible = await tx.project.findFirst({
          where: { id: projectId, ...this.currentVisibleProject(userId) },
          select: { id: true },
        });
        if (!visible) throw new NotFoundException('项目不存在');
        throw new ForbiddenException('没有维护此客户的权限');
      }
      return customer;
    });
  }

  private async assertCanManage(userId: string, customerId: string): Promise<void> {
    const visible = await this.prisma.customer.findFirst({
      where: {
        id: customerId,
        status: { not: 'ARCHIVED' },
        deletedAt: null,
        projects: { some: this.currentVisibleProject(userId) },
      },
      select: { id: true },
    });
    if (!visible) throw new NotFoundException('客户不存在');
    await this.assertSystemManage(userId);
    const manageable = await this.prisma.customer.findFirst({
      where: {
        id: customerId,
        status: { not: 'ARCHIVED' },
        deletedAt: null,
        projects: { some: this.currentSensitiveProject(userId) },
      },
      select: { id: true },
    });
    if (!manageable) throw new ForbiddenException('没有维护此客户的权限');
  }

  async update(
    userId: string,
    customerId: string,
    input: Record<string, unknown> & { version: number },
  ) {
    assertAllowedCustomerUpdate(input);
    await this.assertCanManage(userId, customerId);
    const { version, ...data } = input;
    const result = await this.prisma.customer.updateMany({
      where: {
        id: customerId,
        version,
        status: { not: 'ARCHIVED' },
        deletedAt: null,
        projects: { some: this.currentSensitiveProject(userId) },
      },
      data: { ...data, version: { increment: 1 } },
    });
    if (result.count !== 1) {
      await this.classifyCustomerMutationFailure(this.prisma, userId, customerId);
    }
    return this.get(userId, customerId);
  }

  private async classifyCustomerMutationFailure(
    db: Pick<Prisma.TransactionClient, 'customer'>,
    userId: string,
    customerId: string,
  ): Promise<never> {
    const manageable = await db.customer.findFirst({
      where: {
        id: customerId,
        status: { not: 'ARCHIVED' },
        deletedAt: null,
        projects: { some: this.currentSensitiveProject(userId) },
      },
      select: { id: true },
    });
    if (manageable) throw new ConflictException('客户已被其他用户修改');
    const visible = await db.customer.findFirst({
      where: {
        id: customerId,
        status: { not: 'ARCHIVED' },
        deletedAt: null,
        projects: { some: this.currentVisibleProject(userId) },
      },
      select: { id: true },
    });
    if (!visible) throw new NotFoundException('客户不存在');
    throw new ForbiddenException('没有维护此客户的权限');
  }

  async archive(userId: string, customerId: string, version: number) {
    await this.assertCanManage(userId, customerId);
    const result = await this.prisma.customer.updateMany({
      where: {
        id: customerId,
        version,
        status: { not: 'ARCHIVED' },
        deletedAt: null,
        projects: { some: this.currentSensitiveProject(userId) },
      },
      data: { status: 'ARCHIVED', deletedAt: new Date(), version: { increment: 1 } },
    });
    if (result.count !== 1) {
      await this.classifyCustomerMutationFailure(this.prisma, userId, customerId);
    }
    return { ok: true };
  }

  async assertCustomerManager(userId: string, customerId: string): Promise<void> {
    await this.assertCanManage(userId, customerId);
  }

  async listContacts(userId: string, customerId: string) {
    await this.assertCustomerManager(userId, customerId);
    return this.prisma.customerContact.findMany({
      where: {
        customerId,
        archivedAt: null,
        customer: {
          status: { not: 'ARCHIVED' },
          deletedAt: null,
          projects: { some: this.currentSensitiveProject(userId) },
        },
      },
      select: CONTACT_PUBLIC_SELECT,
      orderBy: [{ isPrimary: 'desc' }, { name: 'asc' }, { id: 'asc' }],
    });
  }

  async createContact(
    userId: string,
    customerId: string,
    input: Record<string, unknown> & { version: number; name: string },
  ) {
    assertAllowedContactWrite(input);
    await this.assertCustomerManager(userId, customerId);
    const { version, ...data } = input;
    return this.withSerializableRetry(async (tx) => {
      const result = await tx.customer.updateMany({
        where: {
          id: customerId,
          version,
          status: { not: 'ARCHIVED' },
          deletedAt: null,
          projects: { some: this.currentSensitiveProject(userId) },
        },
        data: { version: { increment: 1 } },
      });
      if (result.count !== 1) {
        await this.classifyCustomerMutationFailure(tx, userId, customerId);
      }
      return tx.customerContact.create({
        data: { ...data, customerId } as never,
        select: CONTACT_PUBLIC_SELECT,
      });
    });
  }

  async updateContact(
    userId: string,
    customerId: string,
    contactId: string,
    input: Record<string, unknown> & { version: number },
  ) {
    assertAllowedContactWrite(input);
    await this.assertCustomerManager(userId, customerId);
    const { version, ...data } = input;
    return this.withSerializableRetry(async (tx) => {
      const manageableContact = await tx.customerContact.findFirst({
        where: {
          id: contactId,
          customerId,
          archivedAt: null,
          customer: {
            status: { not: 'ARCHIVED' },
            deletedAt: null,
            projects: { some: this.currentSensitiveProject(userId) },
          },
        },
        select: { id: true },
      });
      if (!manageableContact) {
        await this.classifyContactLookupFailure(tx, userId, customerId, contactId);
      }
      const result = await tx.customer.updateMany({
        where: {
          id: customerId,
          version,
          status: { not: 'ARCHIVED' },
          deletedAt: null,
          projects: { some: this.currentSensitiveProject(userId) },
        },
        data: { version: { increment: 1 } },
      });
      if (result.count !== 1) {
        await this.classifyCustomerMutationFailure(tx, userId, customerId);
      }
      return tx.customerContact.update({
        where: { id: contactId },
        data,
        select: CONTACT_PUBLIC_SELECT,
      });
    });
  }

  private async classifyContactLookupFailure(
    tx: Prisma.TransactionClient,
    userId: string,
    customerId: string,
    contactId: string,
  ): Promise<never> {
    const visibleContact = await tx.customerContact.findFirst({
      where: {
        id: contactId,
        customerId,
        archivedAt: null,
        customer: {
          status: { not: 'ARCHIVED' },
          deletedAt: null,
          projects: { some: this.currentVisibleProject(userId) },
        },
      },
      select: { id: true },
    });
    if (!visibleContact) throw new NotFoundException('客户联系人不存在');
    throw new ForbiddenException('没有维护此客户的权限');
  }

  async archiveContact(userId: string, customerId: string, contactId: string, version: number) {
    await this.assertCustomerManager(userId, customerId);
    return this.withSerializableRetry(async (tx) => {
      const manageableContact = await tx.customerContact.findFirst({
        where: {
          id: contactId,
          customerId,
          archivedAt: null,
          customer: {
            status: { not: 'ARCHIVED' },
            deletedAt: null,
            projects: { some: this.currentSensitiveProject(userId) },
          },
        },
        select: { id: true },
      });
      if (!manageableContact) {
        await this.classifyContactLookupFailure(tx, userId, customerId, contactId);
      }
      const result = await tx.customer.updateMany({
        where: {
          id: customerId,
          version,
          status: { not: 'ARCHIVED' },
          deletedAt: null,
          projects: { some: this.currentSensitiveProject(userId) },
        },
        data: { version: { increment: 1 } },
      });
      if (result.count !== 1) {
        await this.classifyCustomerMutationFailure(tx, userId, customerId);
      }
      await tx.customerContact.update({
        where: { id: contactId },
        data: { archivedAt: new Date() },
        select: { id: true },
      });
      return { ok: true };
    });
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
          throw new ConflictException('客户已被其他用户修改');
        }
      }
    }
    throw new Error('unreachable');
  }

  private async assertSystemManage(userId: string): Promise<void> {
    const permissions = await this.roles.listUserPermissions(userId);
    if (!permissions.includes(PERMISSIONS.PROJECT_MANAGE)) {
      throw new ForbiddenException('缺少客户维护权限');
    }
  }
}
