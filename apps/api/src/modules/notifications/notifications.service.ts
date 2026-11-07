import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../../database/prisma.service';

/**
 * 站内通知（任务 9）。
 *
 * 只服务通知的收件人本人：列表与已读都按 `userId` 过滤，
 * 别人的通知与不存在同一响应（404），避免探测。
 */
@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string, query: { page?: number; pageSize?: number; unreadOnly?: boolean }) {
    const rawPage = Number(query?.page ?? 1);
    const page = Number.isSafeInteger(rawPage) && rawPage >= 1 ? rawPage : 1;
    const rawPageSize = Number(query?.pageSize ?? 20);
    const pageSize =
      Number.isSafeInteger(rawPageSize) && rawPageSize >= 1 ? Math.min(100, rawPageSize) : 20;

    const where = {
      userId,
      ...(query?.unreadOnly ? { status: 'UNREAD' as const } : {}),
    };
    const [items, total, unread] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        select: {
          id: true,
          eventType: true,
          resourceType: true,
          resourceId: true,
          title: true,
          body: true,
          status: true,
          readAt: true,
          createdAt: true,
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.notification.count({ where }),
      this.prisma.notification.count({ where: { userId, status: 'UNREAD' } }),
    ]);
    return { items, page, pageSize, total, unread };
  }

  async markRead(userId: string, notificationId: string) {
    const updated = await this.prisma.notification.updateMany({
      where: { id: notificationId, userId, status: 'UNREAD' },
      data: { status: 'READ', readAt: new Date() },
    });
    if (updated.count !== 1) {
      // 已读幂等：已经读过的通知同样返回成功，其余情况一律 404。
      const existing = await this.prisma.notification.findFirst({
        where: { id: notificationId, userId },
        select: { id: true },
      });
      if (!existing) throw new NotFoundException('通知不存在');
    }
    return { ok: true };
  }
}
