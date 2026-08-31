import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { PortfoliosController } from './portfolios/portfolios.controller';
import { ProjectsController } from './projects/projects.controller';
import { OrdersController } from './orders/orders.controller';

describe('task 7 business controllers', () => {
  const request = { user: { id: 'actor-1' } } as never;

  it('takes project scope for orders only from the routed project id', async () => {
    const service = { list: vi.fn().mockResolvedValue({ items: [] }) };
    const controller = new OrdersController(service as never);
    await controller.list(request, 'project-1', { page: '1' });
    expect(service.list).toHaveBeenCalledWith(
      'actor-1',
      'project-1',
      expect.objectContaining({ page: 1, pageSize: 20 }),
    );
  });

  it('rejects attempts to override routed resource ownership', () => {
    const orderService = { create: vi.fn() };
    const orders = new OrdersController(orderService as never);
    expect(() =>
      orders.create(request, 'project-1', {
        number: 'O-1',
        title: '订单',
        projectId: 'project-2',
      } as never),
    ).toThrow(BadRequestException);
    expect(orderService.create).not.toHaveBeenCalled();
  });

  it('requires and forwards the parent order version for every item write', () => {
    const service = { createItem: vi.fn(), updateItem: vi.fn(), removeItem: vi.fn() };
    const orders = new OrdersController(service as never);

    orders.createItem(request, 'project-1', 'order-1', { version: 3, name: '实施', quantity: 1 });
    orders.updateItem(request, 'project-1', 'order-1', 'item-1', { version: 4, name: '更新实施' });
    orders.archiveItem(request, 'project-1', 'order-1', 'item-1', { version: 5 });

    expect(service.createItem).toHaveBeenCalledWith(
      'actor-1',
      'project-1',
      'order-1',
      expect.objectContaining({ version: 3, name: '实施' }),
    );
    expect(service.updateItem).toHaveBeenCalledWith(
      'actor-1',
      'project-1',
      'order-1',
      'item-1',
      expect.objectContaining({ version: 4, name: '更新实施' }),
    );
    expect(service.removeItem).toHaveBeenCalledWith('actor-1', 'project-1', 'order-1', 'item-1', 5);
    expect(() =>
      orders.createItem(request, 'project-1', 'order-1', { name: '缺版本', quantity: 1 } as never),
    ).toThrow(BadRequestException);
  });

  it('rejects invalid portfolio and project writes before services are called', () => {
    const portfolioService = { create: vi.fn() };
    const projectService = { addMember: vi.fn() };
    const portfolios = new PortfoliosController(portfolioService as never);
    const projects = new ProjectsController(projectService as never);

    expect(() =>
      portfolios.create(request, { name: '组合', ownerId: 'attacker' } as never),
    ).toThrow(BadRequestException);
    expect(() =>
      projects.addMember(request, 'project-1', { userId: 'user-2', roles: ['OWNER'] } as never),
    ).toThrow(BadRequestException);
    expect(portfolioService.create).not.toHaveBeenCalled();
    expect(projectService.addMember).not.toHaveBeenCalled();
  });
});
