import { BadRequestException, Injectable } from '@nestjs/common';

import { PrismaService } from '../../database/prisma.service';
import {
  BUSINESS_TIMEZONE,
  zonedDayEndExclusiveUtc,
  zonedDayStartUtc,
} from '../reports/business-time';

/**
 * 审计查询（任务 11）。
 *
 * 只读：这里没有任何写接口，审计行只能由 AuditService 追加（"审计不可修改"）。
 */
@Injectable()
export class AdminAuditService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: {
    page?: number;
    pageSize?: number;
    actorId?: string | null;
    resourceType?: string | null;
    action?: string | null;
    from?: string | null;
    to?: string | null;
  }) {
    const rawPage = Number(query?.page ?? 1);
    const page = Number.isSafeInteger(rawPage) && rawPage >= 1 ? rawPage : 1;
    const rawPageSize = Number(query?.pageSize ?? 20);
    const pageSize =
      Number.isSafeInteger(rawPageSize) && rawPageSize >= 1 ? Math.min(100, rawPageSize) : 20;

    const createdAt: { gte?: Date; lt?: Date } = {};
    if (query?.from) createdAt.gte = this.parseDay(query.from);
    if (query?.to) createdAt.lt = this.parseDayEnd(query.to);

    const where = {
      ...(query?.actorId ? { actorId: query.actorId } : {}),
      ...(query?.resourceType ? { resourceType: query.resourceType } : {}),
      ...(query?.action ? { action: query.action } : {}),
      ...(Object.keys(createdAt).length > 0 ? { createdAt } : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        select: {
          id: true,
          actorId: true,
          action: true,
          resourceType: true,
          resourceId: true,
          projectId: true,
          result: true,
          summary: true,
          createdAt: true,
          actor: { select: { id: true, name: true } },
        },
        // 同一毫秒内也要有稳定顺序，避免翻页漏行/重复。
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return { items, page, pageSize, total, timezone: BUSINESS_TIMEZONE };
  }

  private parseDay(value: string): Date {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
      throw new BadRequestException('日期格式必须为 YYYY-MM-DD');
    const parsed = zonedDayStartUtc(value);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) === 'Invalid') {
      throw new BadRequestException('日期不存在');
    }
    return parsed;
  }

  private parseDayEnd(value: string): Date {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
      throw new BadRequestException('日期格式必须为 YYYY-MM-DD');
    return zonedDayEndExclusiveUtc(value);
  }
}
