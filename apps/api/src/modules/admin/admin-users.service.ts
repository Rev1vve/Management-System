import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from '../../database/prisma.service';
import { AuditService } from '../audit/audit.service';

const USER_STATUSES = new Set(['ACTIVE', 'SUSPENDED', 'INVITED', 'ARCHIVED']);

/**
 * 管理中心：用户与角色管理（任务 11）。
 *
 * 关键约束（D-027 / 计划 §3）：
 *  - 管理权限只来自 `user:manage`，管理员**不会**因此获得任何业务数据读取权；
 *  - 每个写操作都写审计；审计本身没有写接口（只能由 AuditService 追加）；
 *  - 不能停用自己、不能改自己的角色——避免把自己锁在门外。
 */
@Injectable()
export class AdminUsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async listUsers(query: { page?: number; pageSize?: number; search?: string }) {
    const rawPage = Number(query?.page ?? 1);
    const page = Number.isSafeInteger(rawPage) && rawPage >= 1 ? rawPage : 1;
    const rawPageSize = Number(query?.pageSize ?? 20);
    const pageSize =
      Number.isSafeInteger(rawPageSize) && rawPageSize >= 1 ? Math.min(100, rawPageSize) : 20;
    const search = (query?.search ?? '').trim();

    const where = search
      ? {
          OR: [
            { account: { contains: search, mode: 'insensitive' as const } },
            { name: { contains: search, mode: 'insensitive' as const } },
            { workEmail: { contains: search, mode: 'insensitive' as const } },
          ],
        }
      : {};

    const [items, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        // 只返回管理所需的字段：绝不带 passwordHash / mfaSecretCiphertext / recovery codes。
        select: {
          id: true,
          account: true,
          name: true,
          workEmail: true,
          status: true,
          mfaEnabled: true,
          createdAt: true,
          systemRoles: {
            select: { systemRole: { select: { key: true, name: true } } },
          },
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.user.count({ where }),
    ]);

    return {
      items: items.map((user) => ({
        id: user.id,
        account: user.account,
        name: user.name,
        workEmail: user.workEmail,
        status: user.status,
        mfaEnabled: user.mfaEnabled,
        createdAt: user.createdAt,
        roles: user.systemRoles.map((row) => ({
          key: row.systemRole.key,
          name: row.systemRole.name,
        })),
      })),
      page,
      pageSize,
      total,
    };
  }

  async setStatus(actorId: string, userId: string, status: string) {
    if (!USER_STATUSES.has(status)) throw new BadRequestException('用户状态非法');
    if (userId === actorId) throw new ForbiddenException('不能修改自己的账号状态');

    const target = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });
    if (!target) throw new NotFoundException('用户不存在');

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { status: status as 'ACTIVE' | 'SUSPENDED' | 'INVITED' | 'ARCHIVED' },
      select: { id: true, status: true },
    });
    await this.audit.record({
      actorId,
      action: 'user.status.changed',
      resourceType: 'USER',
      resourceId: userId,
      result: 'SUCCESS',
      summary: `状态变更为 ${status}`,
    });
    return updated;
  }

  async setRoles(actorId: string, userId: string, roleKeys: string[]) {
    if (userId === actorId) throw new ForbiddenException('不能修改自己的角色');
    const unique = [...new Set(roleKeys)];
    const roles = await this.prisma.systemRole.findMany({
      where: { key: { in: unique } },
      select: { id: true, key: true },
    });
    if (roles.length !== unique.length) throw new BadRequestException('包含未知的系统角色');

    const target = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });
    if (!target) throw new NotFoundException('用户不存在');

    await this.prisma.$transaction(async (tx) => {
      await tx.userSystemRole.deleteMany({ where: { userId } });
      for (const role of roles) {
        await tx.userSystemRole.create({ data: { userId, systemRoleId: role.id } });
      }
    });
    await this.audit.record({
      actorId,
      action: 'user.roles.changed',
      resourceType: 'USER',
      resourceId: userId,
      result: 'SUCCESS',
      summary: `角色变更为 ${unique.sort().join(', ') || '(none)'}`,
    });
    return { id: userId, roles: roles.map((role) => role.key).sort() };
  }

  /** 角色清单：让管理中心能授予 `report:drilldown` 这类默认不给角色的能力。 */
  async listRoles() {
    const roles = await this.prisma.systemRole.findMany({
      select: {
        key: true,
        name: true,
        description: true,
        requiresMfa: true,
        rolePermissions: { select: { permission: { select: { key: true } } } },
      },
      orderBy: { key: 'asc' },
    });
    return roles.map((role) => ({
      key: role.key,
      name: role.name,
      description: role.description,
      requiresMfa: role.requiresMfa,
      permissions: role.rolePermissions.map((row) => row.permission.key).sort(),
    }));
  }
}
