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

export interface OrderListQuery {
  page: number;
  pageSize: number;
  search?: string;
  status?: string;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

const ORDER_SELECT = {
  id: true,
  number: true,
  projectId: true,
  title: true,
  description: true,
  startDate: true,
  deliveryDate: true,
  status: true,
  version: true,
  updatedAt: true,
} as const;
const ITEM_SELECT = {
  id: true,
  orderId: true,
  name: true,
  quantity: true,
  unit: true,
  plannedDate: true,
  completedDate: true,
  status: true,
  sortOrder: true,
  updatedAt: true,
} as const;

const ORDER_CREATE_FIELDS = new Set([
  'number',
  'title',
  'description',
  'startDate',
  'deliveryDate',
  'status',
]);
const ORDER_UPDATE_FIELDS = new Set([...ORDER_CREATE_FIELDS, 'version']);
const ITEM_WRITE_FIELDS = new Set([
  'version',
  'name',
  'quantity',
  'unit',
  'plannedDate',
  'completedDate',
  'status',
  'sortOrder',
]);

function assertAllowedFields(input: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new BadRequestException(`不支持的字段：${unknown.join(', ')}`);
}

function assertNotDirectArchive(input: Record<string, unknown>): void {
  if (input.status === 'ARCHIVED') {
    throw new BadRequestException('请使用订单归档操作');
  }
}

const ORDER_TRANSITIONS: Record<string, ReadonlySet<string>> = {
  DRAFT: new Set(['DRAFT', 'ACTIVE', 'CANCELLED']),
  ACTIVE: new Set(['ACTIVE', 'COMPLETED', 'CANCELLED']),
  COMPLETED: new Set(['COMPLETED']),
  CANCELLED: new Set(['CANCELLED']),
};
const SERIALIZABLE_TRANSACTION_OPTIONS = {
  isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
} as const;
const SERIALIZABLE_TRANSACTION_ATTEMPTS = 3;

function assertOrderDates(startDate: unknown, deliveryDate: unknown): void {
  if (
    startDate instanceof Date &&
    deliveryDate instanceof Date &&
    startDate.getTime() > deliveryDate.getTime()
  ) {
    throw new BadRequestException('订单开始日期不能晚于交付日期');
  }
}

function assertInitialOrderStatus(status: unknown): void {
  if (status !== undefined && status !== 'DRAFT') {
    throw new BadRequestException('订单必须从 DRAFT 状态创建');
  }
}

function assertOrderTransition(current: unknown, next: unknown): void {
  if (typeof current !== 'string' || typeof next !== 'string' || current === next) return;
  if (!ORDER_TRANSITIONS[current]?.has(next)) {
    throw new BadRequestException(`订单状态不能从 ${current} 变更为 ${next}`);
  }
}

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projectAccess: ProjectAccessService,
    private readonly roles: RolesService,
  ) {}

  private activeProjectMembership(userId: string, managerOnly = false) {
    return {
      status: { not: 'ARCHIVED' as const },
      deletedAt: null,
      memberships: {
        some: {
          userId,
          user: {
            status: 'ACTIVE' as const,
            deletedAt: null,
            ...(managerOnly
              ? {
                  systemRoles: {
                    some: {
                      systemRole: {
                        rolePermissions: {
                          some: { permission: { key: PERMISSIONS.PROJECT_MANAGE } },
                        },
                      },
                    },
                  },
                }
              : {}),
          },
          ...(managerOnly ? { roles: { some: { role: 'PROJECT_MANAGER' as const } } } : {}),
        },
      },
    };
  }

  private activeOrderForUser(userId: string, projectId: string, managerOnly = false) {
    return {
      projectId,
      status: { not: 'ARCHIVED' as const },
      deletedAt: null,
      project: this.activeProjectMembership(userId, managerOnly),
    };
  }

  async list(userId: string, projectId: string, query: OrderListQuery) {
    const access = await this.projectAccess.assertProjectAccess(userId, projectId);
    const canManage =
      access.roles.includes('PROJECT_MANAGER') &&
      (await this.roles.listUserPermissions(userId)).includes(PERMISSIONS.PROJECT_MANAGE);
    const where: Prisma.OrderWhereInput = {
      projectId,
      project: this.activeProjectMembership(userId),
      deletedAt: null,
      AND: [
        { status: { not: 'ARCHIVED' as const } },
        ...(query.status ? [{ status: query.status as never }] : []),
      ],
      ...(query.search
        ? {
            OR: [
              { number: { contains: query.search, mode: 'insensitive' as const } },
              { title: { contains: query.search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };
    const [total, items] = await Promise.all([
      this.prisma.order.count({ where }),
      this.prisma.order.findMany({
        where,
        select: ORDER_SELECT,
        orderBy: [{ [query.sortBy ?? 'updatedAt']: query.sortOrder ?? 'desc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);
    return {
      items,
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / query.pageSize),
      canManage,
    };
  }

  async get(userId: string, projectId: string, orderId: string) {
    const access = await this.projectAccess.assertProjectAccess(userId, projectId);
    const order = await this.prisma.order.findFirst({
      where: {
        id: orderId,
        projectId,
        status: { not: 'ARCHIVED' },
        deletedAt: null,
        project: this.activeProjectMembership(userId),
      },
      select: ORDER_SELECT,
    });
    if (!order) throw new NotFoundException('订单不存在');
    if (
      access.roles.includes('PROJECT_MANAGER') &&
      (await this.roles.listUserPermissions(userId)).includes(PERMISSIONS.PROJECT_MANAGE)
    ) {
      return { ...order, canManage: true };
    }
    return order;
  }

  async create(userId: string, projectId: string, data: Record<string, unknown>) {
    assertAllowedFields(data, ORDER_CREATE_FIELDS);
    assertInitialOrderStatus(data.status);
    assertOrderDates(data.startDate, data.deliveryDate);
    await this.assertSystemManage(userId);
    await this.projectAccess.assertProjectRole(userId, projectId, ['PROJECT_MANAGER']);
    return this.withOrderItemSerializableRetry(async (tx) => {
      const project = await tx.project.findFirst({
        where: { id: projectId, ...this.activeProjectMembership(userId, true) },
        select: { id: true },
      });
      if (!project) {
        const visible = await tx.project.findFirst({
          where: { id: projectId, ...this.activeProjectMembership(userId) },
          select: { id: true },
        });
        if (!visible) throw new NotFoundException('项目不存在');
        throw new ForbiddenException('缺少订单维护权限');
      }
      return tx.order.create({
        data: { ...data, status: data.status ?? 'DRAFT', projectId } as never,
        select: ORDER_SELECT,
      });
    });
  }

  async update(
    userId: string,
    projectId: string,
    orderId: string,
    input: Record<string, unknown> & { version: number },
  ) {
    assertAllowedFields(input, ORDER_UPDATE_FIELDS);
    assertNotDirectArchive(input);
    await this.assertSystemManage(userId);
    await this.projectAccess.assertProjectRole(userId, projectId, ['PROJECT_MANAGER']);
    const existing = await this.prisma.order.findFirst({
      where: { id: orderId, projectId, status: { not: 'ARCHIVED' }, deletedAt: null },
      select: { id: true, status: true, startDate: true, deliveryDate: true },
    });
    if (!existing) throw new NotFoundException('订单不存在');
    const { version, ...data } = input;
    assertOrderTransition(existing.status, data.status);
    assertOrderDates(
      Object.hasOwn(data, 'startDate') ? data.startDate : existing.startDate,
      Object.hasOwn(data, 'deliveryDate') ? data.deliveryDate : existing.deliveryDate,
    );
    const result = await this.prisma.order.updateMany({
      where: {
        id: orderId,
        projectId,
        version,
        status: { not: 'ARCHIVED' },
        deletedAt: null,
        project: this.activeProjectMembership(userId, true),
      },
      data: { ...data, version: { increment: 1 } },
    });
    if (result.count !== 1) await this.classifyOrderMutationFailure(userId, projectId, orderId);
    return this.get(userId, projectId, orderId);
  }

  async archive(userId: string, projectId: string, orderId: string, version: number) {
    await this.assertSystemManage(userId);
    await this.projectAccess.assertProjectRole(userId, projectId, ['PROJECT_MANAGER']);
    const result = await this.prisma.order.updateMany({
      where: {
        id: orderId,
        projectId,
        version,
        status: { not: 'ARCHIVED' },
        deletedAt: null,
        project: this.activeProjectMembership(userId, true),
      },
      data: { status: 'ARCHIVED', deletedAt: new Date(), version: { increment: 1 } },
    });
    if (result.count !== 1) await this.classifyOrderMutationFailure(userId, projectId, orderId);
    return { ok: true };
  }

  async listItems(userId: string, projectId: string, orderId: string) {
    await this.get(userId, projectId, orderId);
    return this.prisma.orderItem.findMany({
      where: {
        orderId,
        order: this.activeOrderForUser(userId, projectId),
      },
      select: ITEM_SELECT,
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    });
  }

  async getItem(userId: string, projectId: string, orderId: string, itemId: string) {
    await this.projectAccess.assertProjectAccess(userId, projectId);
    const item = await this.prisma.orderItem.findFirst({
      where: {
        id: itemId,
        orderId,
        order: this.activeOrderForUser(userId, projectId),
      },
      select: ITEM_SELECT,
    });
    if (!item) throw new NotFoundException('订单项不存在');
    return item;
  }

  async createItem(
    userId: string,
    projectId: string,
    orderId: string,
    input: Record<string, unknown> & { version: number },
  ) {
    assertAllowedFields(input, ITEM_WRITE_FIELDS);
    await this.assertSystemManage(userId);
    await this.projectAccess.assertProjectRole(userId, projectId, ['PROJECT_MANAGER']);
    const { version, ...data } = input;
    return this.withOrderItemSerializableRetry(async (tx) => {
      const updated = await tx.order.updateMany({
        where: {
          id: orderId,
          projectId,
          project: this.activeProjectMembership(userId, true),
          version,
          status: { not: 'ARCHIVED' },
          deletedAt: null,
        },
        data: { version: { increment: 1 } },
      });
      if (updated.count !== 1) {
        await this.classifyCurrentItemWriteFailure(tx, userId, projectId, orderId);
      }
      return tx.orderItem.create({ data: { ...data, orderId } as never, select: ITEM_SELECT });
    });
  }

  async updateItem(
    userId: string,
    projectId: string,
    orderId: string,
    itemId: string,
    input: Record<string, unknown> & { version: number },
  ) {
    assertAllowedFields(input, ITEM_WRITE_FIELDS);
    await this.assertSystemManage(userId);
    await this.projectAccess.assertProjectRole(userId, projectId, ['PROJECT_MANAGER']);
    const { version, ...data } = input;
    return this.withOrderItemSerializableRetry(async (tx) => {
      const manageableItem = await tx.orderItem.findFirst({
        where: {
          id: itemId,
          orderId,
          order: this.activeOrderForUser(userId, projectId, true),
        },
        select: { id: true },
      });
      if (!manageableItem) {
        await this.classifyCurrentItemWriteFailure(tx, userId, projectId, orderId, itemId);
      }
      const updated = await tx.order.updateMany({
        where: {
          id: orderId,
          projectId,
          project: this.activeProjectMembership(userId, true),
          version,
          status: { not: 'ARCHIVED' },
          deletedAt: null,
        },
        data: { version: { increment: 1 } },
      });
      if (updated.count !== 1) {
        await this.classifyCurrentItemWriteFailure(tx, userId, projectId, orderId, itemId);
      }
      return tx.orderItem.update({ where: { id: itemId }, data, select: ITEM_SELECT });
    });
  }

  async removeItem(
    userId: string,
    projectId: string,
    orderId: string,
    itemId: string,
    version: number,
  ) {
    await this.assertSystemManage(userId);
    await this.projectAccess.assertProjectRole(userId, projectId, ['PROJECT_MANAGER']);
    await this.withOrderItemSerializableRetry(async (tx) => {
      const manageableItem = await tx.orderItem.findFirst({
        where: {
          id: itemId,
          orderId,
          order: this.activeOrderForUser(userId, projectId, true),
        },
        select: { id: true },
      });
      if (!manageableItem) {
        await this.classifyCurrentItemWriteFailure(tx, userId, projectId, orderId, itemId);
      }
      const updated = await tx.order.updateMany({
        where: {
          id: orderId,
          projectId,
          project: this.activeProjectMembership(userId, true),
          version,
          status: { not: 'ARCHIVED' },
          deletedAt: null,
        },
        data: { version: { increment: 1 } },
      });
      if (updated.count !== 1) {
        await this.classifyCurrentItemWriteFailure(tx, userId, projectId, orderId, itemId);
      }
      await tx.orderItem.update({ where: { id: itemId }, data: { status: 'CANCELLED' } });
    });
    return { ok: true };
  }

  private async withOrderItemSerializableRetry<T>(
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; attempt < SERIALIZABLE_TRANSACTION_ATTEMPTS; attempt += 1) {
      try {
        return await this.prisma.$transaction(work, SERIALIZABLE_TRANSACTION_OPTIONS);
      } catch (error) {
        const isWriteConflict =
          typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2034';
        if (!isWriteConflict) throw error;
        if (attempt === SERIALIZABLE_TRANSACTION_ATTEMPTS - 1) {
          throw new ConflictException('订单已被其他用户修改');
        }
      }
    }
    throw new Error('unreachable');
  }

  private async classifyCurrentItemWriteFailure(
    tx: Prisma.TransactionClient,
    userId: string,
    projectId: string,
    orderId: string,
    itemId?: string,
  ): Promise<never> {
    const itemScope = itemId ? { items: { some: { id: itemId } } } : {};
    const manageable = await tx.order.findFirst({
      where: {
        id: orderId,
        projectId,
        project: this.activeProjectMembership(userId, true),
        status: { not: 'ARCHIVED' },
        deletedAt: null,
        ...itemScope,
      },
      select: { id: true },
    });
    if (manageable) throw new ConflictException('订单已被其他用户修改');
    const visible = await tx.order.findFirst({
      where: {
        id: orderId,
        projectId,
        project: this.activeProjectMembership(userId),
        status: { not: 'ARCHIVED' },
        deletedAt: null,
        ...itemScope,
      },
      select: { id: true },
    });
    if (!visible) throw new NotFoundException(itemId ? '订单项不存在' : '订单不存在');
    throw new ForbiddenException('缺少订单维护权限');
  }

  private async classifyOrderMutationFailure(
    userId: string,
    projectId: string,
    orderId: string,
  ): Promise<never> {
    const current = await this.prisma.order.findFirst({
      where: { id: orderId, ...this.activeOrderForUser(userId, projectId, true) },
      select: { id: true },
    });
    if (current) throw new ConflictException('订单已被其他用户修改');
    const visible = await this.prisma.order.findFirst({
      where: { id: orderId, ...this.activeOrderForUser(userId, projectId) },
      select: { id: true },
    });
    if (!visible) throw new NotFoundException('订单不存在');
    throw new ForbiddenException('缺少订单维护权限');
  }

  private async assertSystemManage(userId: string): Promise<void> {
    const permissions = await this.roles.listUserPermissions(userId);
    if (!permissions.includes(PERMISSIONS.PROJECT_MANAGE)) {
      throw new ForbiddenException('缺少订单维护权限');
    }
  }
}
