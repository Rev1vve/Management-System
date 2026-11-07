import { NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NotificationsService } from './notifications.service';

function createPrismaMock() {
  return {
    notification: {
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      findFirst: vi.fn().mockResolvedValue(null),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
}

describe('NotificationsService', () => {
  let prisma: ReturnType<typeof createPrismaMock>;

  beforeEach(() => {
    prisma = createPrismaMock();
  });

  it('lists only the caller notifications with paging and unread count', async () => {
    const service = new NotificationsService(prisma as never);

    await service.list('user-1', { page: 2, pageSize: 5 });

    expect(prisma.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user-1' },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: 5,
        take: 5,
      }),
    );
    expect(prisma.notification.count).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
    expect(prisma.notification.count).toHaveBeenCalledWith({
      where: { userId: 'user-1', status: 'UNREAD' },
    });
  });

  it('filters to unread only when asked', async () => {
    const service = new NotificationsService(prisma as never);

    await service.list('user-1', { unreadOnly: true });

    expect(prisma.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user-1', status: 'UNREAD' } }),
    );
  });

  it('marks a notification read and is idempotent for an already-read row', async () => {
    const service = new NotificationsService(prisma as never);
    prisma.notification.updateMany.mockResolvedValue({ count: 0 });
    prisma.notification.findFirst.mockResolvedValue({ id: 'n-1' });

    await expect(service.markRead('user-1', 'n-1')).resolves.toEqual({ ok: true });
  });

  it('hides other users notifications behind 404', async () => {
    const service = new NotificationsService(prisma as never);
    prisma.notification.updateMany.mockResolvedValue({ count: 0 });
    prisma.notification.findFirst.mockResolvedValue(null);

    await expect(service.markRead('user-1', 'n-other')).rejects.toBeInstanceOf(NotFoundException);
  });
});
