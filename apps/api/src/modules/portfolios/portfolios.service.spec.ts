import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { PortfoliosService } from './portfolios.service';

const portfolioManage = { listUserPermissions: vi.fn().mockResolvedValue(['portfolio:manage']) };

describe('PortfoliosService', () => {
  it('lists portfolios only through portfolio memberships', async () => {
    const prisma = {
      portfolio: {
        count: vi.fn().mockResolvedValue(1),
        findMany: vi.fn().mockResolvedValue([{ id: 'pf1' }]),
      },
    };
    const service = new PortfoliosService(prisma as never, portfolioManage as never);
    await expect(service.list('u1', { page: 1, pageSize: 20 })).resolves.toMatchObject({
      canManage: true,
    });
    expect(prisma.portfolio.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          memberships: {
            some: { userId: 'u1', user: { status: 'ACTIVE', deletedAt: null } },
          },
        }),
      }),
    );
  });

  it('excludes archived portfolios from both list items and total even when explicitly requested', async () => {
    const prisma = {
      portfolio: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
    };
    const service = new PortfoliosService(prisma as never, portfolioManage as never);

    await service.list('u1', { page: 1, pageSize: 20, status: 'ARCHIVED' });

    const activeMembershipWhere = {
      deletedAt: null,
      memberships: {
        some: { userId: 'u1', user: { status: 'ACTIVE', deletedAt: null } },
      },
      AND: [{ status: { not: 'ARCHIVED' } }, { status: 'ARCHIVED' }],
    };
    expect(prisma.portfolio.count).toHaveBeenCalledWith({ where: activeMembershipWhere });
    expect(prisma.portfolio.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: activeMembershipWhere }),
    );
  });

  it('advertises portfolio creation from system permission even before the first membership exists', async () => {
    const prisma = {
      portfolio: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
    };
    const denied = new PortfoliosService(
      prisma as never,
      { listUserPermissions: vi.fn().mockResolvedValue([]) } as never,
    );
    await expect(denied.list('u1', { page: 1, pageSize: 20 })).resolves.toMatchObject({
      canManage: false,
    });

    const allowed = new PortfoliosService(
      prisma as never,
      { listUserPermissions: vi.fn().mockResolvedValue(['portfolio:manage']) } as never,
    );
    await expect(allowed.list('u1', { page: 1, pageSize: 20 })).resolves.toMatchObject({
      canManage: true,
    });
  });

  it('creates a portfolio and creator membership atomically', async () => {
    const tx = {
      user: { findFirst: vi.fn().mockResolvedValue({ id: 'u1' }) },
      portfolio: { create: vi.fn().mockResolvedValue({ id: 'pf1' }) },
      portfolioMembership: { create: vi.fn().mockResolvedValue({}) },
    };
    const prisma = { $transaction: vi.fn(async (cb: (value: typeof tx) => unknown) => cb(tx)) };
    const service = new PortfoliosService(prisma as never, portfolioManage as never);
    await service.create('u1', { name: '组合' });
    expect(tx.portfolioMembership.create).toHaveBeenCalledWith({
      data: { userId: 'u1', portfolioId: 'pf1' },
    });
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'Serializable',
    });
  });

  it('rejects unknown update fields before membership lookup', async () => {
    const prisma = { portfolio: { findFirst: vi.fn(), update: vi.fn() } };
    const service = new PortfoliosService(prisma as never, portfolioManage as never);

    await expect(
      service.update('user-1', 'portfolio-1', { ownerId: 'attacker' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.portfolio.findFirst).not.toHaveBeenCalled();
    expect(prisma.portfolio.update).not.toHaveBeenCalled();
  });

  it('rejects ARCHIVED as an ordinary update status after enforcing permission and membership', async () => {
    const active = { id: 'portfolio-1', name: '组合', status: 'ACTIVE' };
    const prisma = {
      portfolio: { findFirst: vi.fn().mockResolvedValue(active), update: vi.fn() },
    };
    const roles = { listUserPermissions: vi.fn().mockResolvedValue(['portfolio:manage']) };
    const service = new PortfoliosService(prisma as never, roles as never);

    await expect(
      service.update('user-1', 'portfolio-1', { status: 'ARCHIVED' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(roles.listUserPermissions).toHaveBeenCalledWith('user-1');
    expect(prisma.portfolio.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'portfolio-1',
          memberships: { some: expect.objectContaining({ userId: 'user-1' }) },
        }),
      }),
    );
    expect(prisma.portfolio.update).not.toHaveBeenCalled();
  });

  it('returns 404 and does not write when updating an archived portfolio', async () => {
    const archived = { id: 'portfolio-1', name: '组合', status: 'ARCHIVED' };
    const prisma = {
      portfolio: { findFirst: vi.fn().mockResolvedValue(archived), update: vi.fn() },
    };
    const roles = { listUserPermissions: vi.fn().mockResolvedValue(['portfolio:manage']) };
    const service = new PortfoliosService(prisma as never, roles as never);

    await expect(
      service.update('user-1', 'portfolio-1', { name: '不得恢复' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(roles.listUserPermissions).toHaveBeenCalledWith('user-1');
    expect(prisma.portfolio.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'portfolio-1',
          deletedAt: null,
          status: { not: 'ARCHIVED' },
          memberships: { some: expect.objectContaining({ userId: 'user-1' }) },
        }),
      }),
    );
    expect(prisma.portfolio.update).not.toHaveBeenCalled();
  });

  it('returns 404 if the portfolio is archived between the membership check and update', async () => {
    const active = { id: 'portfolio-1', name: '组合', status: 'ACTIVE' };
    const prisma = {
      portfolio: {
        findFirst: vi.fn().mockResolvedValueOnce(active).mockResolvedValueOnce(null),
        update: vi.fn().mockRejectedValue({ code: 'P2025' }),
      },
    };
    const roles = { listUserPermissions: vi.fn().mockResolvedValue(['portfolio:manage']) };
    const service = new PortfoliosService(prisma as never, roles as never);

    await expect(
      service.update('user-1', 'portfolio-1', { name: '不得越过归档边界' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.portfolio.update).toHaveBeenCalledWith({
      where: {
        id: 'portfolio-1',
        deletedAt: null,
        status: { not: 'ARCHIVED' },
        memberships: { some: expect.objectContaining({ userId: 'user-1' }) },
      },
      data: { name: '不得越过归档边界' },
      select: expect.any(Object),
    });
  });

  it('archives a portfolio by setting both ARCHIVED and deletedAt after permission and membership checks', async () => {
    const active = { id: 'portfolio-1', name: '组合', status: 'ACTIVE' };
    const prisma = {
      portfolio: {
        findFirst: vi.fn().mockResolvedValue(active),
        update: vi.fn().mockResolvedValue({ ...active, status: 'ARCHIVED' }),
      },
    };
    const roles = { listUserPermissions: vi.fn().mockResolvedValue(['portfolio:manage']) };
    const service = new PortfoliosService(prisma as never, roles as never);

    await service.archive('user-1', 'portfolio-1');

    expect(roles.listUserPermissions).toHaveBeenCalledWith('user-1');
    expect(prisma.portfolio.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'portfolio-1',
          memberships: { some: expect.objectContaining({ userId: 'user-1' }) },
        }),
      }),
    );
    expect(prisma.portfolio.update).toHaveBeenCalledWith({
      where: {
        id: 'portfolio-1',
        deletedAt: null,
        status: { not: 'ARCHIVED' },
        memberships: { some: expect.objectContaining({ userId: 'user-1' }) },
      },
      data: { status: 'ARCHIVED', deletedAt: expect.any(Date) },
      select: expect.any(Object),
    });
  });

  it('returns 404 if membership is revoked between archive authorization and the write', async () => {
    const active = { id: 'portfolio-1', name: '组合', status: 'ACTIVE' };
    const prisma = {
      portfolio: {
        findFirst: vi.fn().mockResolvedValueOnce(active).mockResolvedValueOnce(null),
        update: vi.fn().mockRejectedValue({ code: 'P2025' }),
      },
    };
    const service = new PortfoliosService(prisma as never, portfolioManage as never);

    await expect(service.archive('user-1', 'portfolio-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it.each(['update', 'archive'] as const)(
    'returns 403 when final %s predicate loses portfolio:manage but membership remains visible',
    async (operation) => {
      const active = { id: 'portfolio-1', name: '组合', status: 'ACTIVE' };
      const prisma = {
        portfolio: {
          findFirst: vi.fn().mockResolvedValue(active),
          update: vi.fn().mockRejectedValue({ code: 'P2025' }),
        },
      };
      const service = new PortfoliosService(prisma as never, portfolioManage as never);

      const result =
        operation === 'update'
          ? service.update('u1', 'portfolio-1', { name: 'new' })
          : service.archive('u1', 'portfolio-1');
      await expect(result).rejects.toBeInstanceOf(ForbiddenException);

      expect(prisma.portfolio.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            memberships: {
              some: {
                userId: 'u1',
                user: expect.objectContaining({
                  status: 'ACTIVE',
                  deletedAt: null,
                  systemRoles: {
                    some: {
                      systemRole: {
                        rolePermissions: {
                          some: { permission: { key: 'portfolio:manage' } },
                        },
                      },
                    },
                  },
                }),
              },
            },
          }),
        }),
      );
    },
  );

  it('gets a portfolio only through a final active-user membership predicate', async () => {
    const detail = { id: 'pf1', name: '组合', status: 'ACTIVE' };
    const prisma = { portfolio: { findFirst: vi.fn().mockResolvedValue(detail) } };
    const service = new PortfoliosService(prisma as never, portfolioManage as never);

    await expect(service.get('u1', 'pf1')).resolves.toMatchObject(detail);
    expect(prisma.portfolio.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          memberships: {
            some: { userId: 'u1', user: { status: 'ACTIVE', deletedAt: null } },
          },
        }),
      }),
    );
  });

  it('returns an explicit write capability only when membership and system permission both allow it', async () => {
    const detail = { id: 'pf1', name: '组合', status: 'ACTIVE' };
    const prisma = { portfolio: { findFirst: vi.fn().mockResolvedValue(detail) } };
    const roles = { listUserPermissions: vi.fn().mockResolvedValue(['portfolio:manage']) };
    const service = new PortfoliosService(prisma as never, roles as never);

    await expect(service.get('u1', 'pf1')).resolves.toEqual({ ...detail, canManage: true });
  });

  it('treats an archived portfolio as missing even when deletedAt is null', async () => {
    const prisma = {
      portfolio: {
        findFirst: vi.fn().mockResolvedValue({ id: 'pf1', status: 'ARCHIVED', deletedAt: null }),
      },
    };
    const service = new PortfoliosService(prisma as never, portfolioManage as never);

    await expect(service.get('u1', 'pf1')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.portfolio.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'pf1',
          deletedAt: null,
          status: { not: 'ARCHIVED' },
          memberships: {
            some: { userId: 'u1', user: { status: 'ACTIVE', deletedAt: null } },
          },
        }),
      }),
    );
  });

  it('bounds P2034 retries and returns a stable conflict after exhaustion', async () => {
    const conflict = Object.assign(new Error('write conflict'), { code: 'P2034' });
    const tx = {
      user: { findFirst: vi.fn().mockResolvedValue({ id: 'u1' }) },
      portfolio: { create: vi.fn().mockResolvedValue({ id: 'pf1' }) },
      portfolioMembership: { create: vi.fn().mockResolvedValue({}) },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => {
        await callback(tx);
        throw conflict;
      }),
    };
    const service = new PortfoliosService(prisma as never, portfolioManage as never);

    await expect(service.create('u1', { name: '组合' })).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.$transaction).toHaveBeenCalledTimes(3);
  });

  it('denies service-layer writes without portfolio:manage before database access', async () => {
    const prisma = { $transaction: vi.fn() };
    const roles = { listUserPermissions: vi.fn().mockResolvedValue([]) };
    const service = new PortfoliosService(prisma as never, roles as never);

    await expect(service.create('u1', { name: '组合' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
