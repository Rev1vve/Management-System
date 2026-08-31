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
import { RolesService } from '../roles/roles.service';

export interface PortfolioListQuery {
  page: number;
  pageSize: number;
  search?: string;
  status?: string;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

const PORTFOLIO_SELECT = {
  id: true,
  name: true,
  description: true,
  status: true,
  updatedAt: true,
} as const;

const PORTFOLIO_UPDATE_FIELDS = new Set(['name', 'description', 'status']);
const SERIALIZABLE_TRANSACTION_ATTEMPTS = 3;

function assertAllowedPortfolioUpdate(data: Record<string, unknown>): void {
  const unknown = Object.keys(data).filter((key) => !PORTFOLIO_UPDATE_FIELDS.has(key));
  if (unknown.length > 0) throw new BadRequestException(`不支持的字段：${unknown.join(', ')}`);
}

@Injectable()
export class PortfoliosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly roles: RolesService,
  ) {}

  private currentManageMembership(userId: string) {
    return {
      userId,
      user: {
        status: 'ACTIVE' as const,
        deletedAt: null,
        systemRoles: {
          some: {
            systemRole: {
              rolePermissions: {
                some: { permission: { key: PERMISSIONS.PORTFOLIO_MANAGE } },
              },
            },
          },
        },
      },
    };
  }

  async list(userId: string, query: PortfolioListQuery) {
    const where = {
      deletedAt: null,
      memberships: {
        some: { userId, user: { status: 'ACTIVE' as const, deletedAt: null } },
      },
      AND: [
        { status: { not: 'ARCHIVED' as const } },
        ...(query.status ? [{ status: query.status as never }] : []),
      ],
      ...(query.search ? { name: { contains: query.search, mode: 'insensitive' as const } } : {}),
    };
    const [total, items] = await Promise.all([
      this.prisma.portfolio.count({ where }),
      this.prisma.portfolio.findMany({
        where,
        select: PORTFOLIO_SELECT,
        orderBy: [{ [query.sortBy ?? 'updatedAt']: query.sortOrder ?? 'desc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);
    // Collection capability controls creation; create() grants the first
    // membership atomically, so an empty current scope must not hide it.
    const canManage = (await this.roles.listUserPermissions(userId)).includes(
      PERMISSIONS.PORTFOLIO_MANAGE,
    );
    return {
      items,
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / query.pageSize),
      canManage,
    };
  }

  async get(userId: string, portfolioId: string) {
    const portfolio = await this.prisma.portfolio.findFirst({
      where: {
        id: portfolioId,
        deletedAt: null,
        status: { not: 'ARCHIVED' },
        memberships: {
          some: { userId, user: { status: 'ACTIVE', deletedAt: null } },
        },
      },
      select: PORTFOLIO_SELECT,
    });
    if (!portfolio || portfolio.status === 'ARCHIVED') throw new NotFoundException('项目集不存在');
    if ((await this.roles.listUserPermissions(userId)).includes(PERMISSIONS.PORTFOLIO_MANAGE)) {
      return { ...portfolio, canManage: true };
    }
    return portfolio;
  }

  async create(userId: string, input: { name: string; description?: string | null }) {
    await this.assertSystemManage(userId);
    return this.withSerializableRetry(async (tx) => {
      await this.assertCurrentSystemManage(tx, userId);
      const portfolio = await tx.portfolio.create({ data: input, select: PORTFOLIO_SELECT });
      await tx.portfolioMembership.create({ data: { userId, portfolioId: portfolio.id } });
      return portfolio;
    });
  }

  async update(userId: string, portfolioId: string, data: Record<string, unknown>) {
    assertAllowedPortfolioUpdate(data);
    await this.assertSystemManage(userId);
    await this.get(userId, portfolioId);
    if (data.status === 'ARCHIVED') throw new BadRequestException('请使用归档接口');
    try {
      return await this.prisma.portfolio.update({
        where: {
          id: portfolioId,
          deletedAt: null,
          status: { not: 'ARCHIVED' },
          memberships: { some: this.currentManageMembership(userId) },
        },
        data,
        select: PORTFOLIO_SELECT,
      });
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'P2025'
      ) {
        await this.classifyMutationFailure(userId, portfolioId);
      }
      throw error;
    }
  }

  async archive(userId: string, portfolioId: string) {
    await this.assertSystemManage(userId);
    await this.get(userId, portfolioId);
    try {
      return await this.prisma.portfolio.update({
        where: {
          id: portfolioId,
          deletedAt: null,
          status: { not: 'ARCHIVED' },
          memberships: { some: this.currentManageMembership(userId) },
        },
        data: { status: 'ARCHIVED', deletedAt: new Date() },
        select: PORTFOLIO_SELECT,
      });
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'P2025'
      ) {
        await this.classifyMutationFailure(userId, portfolioId);
      }
      throw error;
    }
  }

  private async assertSystemManage(userId: string): Promise<void> {
    const permissions = await this.roles.listUserPermissions(userId);
    if (!permissions.includes(PERMISSIONS.PORTFOLIO_MANAGE)) {
      throw new ForbiddenException('缺少项目集维护权限');
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
                some: { permission: { key: PERMISSIONS.PORTFOLIO_MANAGE } },
              },
            },
          },
        },
      },
      select: { id: true },
    });
    if (!user) throw new ForbiddenException('缺少项目集维护权限');
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
          throw new ConflictException('项目集已被其他用户修改');
        }
      }
    }
    throw new Error('unreachable');
  }

  private async classifyMutationFailure(userId: string, portfolioId: string): Promise<never> {
    const visible = await this.prisma.portfolio.findFirst({
      where: {
        id: portfolioId,
        deletedAt: null,
        status: { not: 'ARCHIVED' },
        memberships: {
          some: { userId, user: { status: 'ACTIVE', deletedAt: null } },
        },
      },
      select: { id: true },
    });
    if (!visible) throw new NotFoundException('项目集不存在');
    throw new ForbiddenException('缺少项目集维护权限');
  }
}
