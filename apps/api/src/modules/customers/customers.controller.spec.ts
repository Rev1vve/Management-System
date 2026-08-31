import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { CustomersController } from './customers.controller';

describe('CustomersController', () => {
  it('parses a scoped list query and takes the actor only from the authenticated request', async () => {
    const service = { list: vi.fn().mockResolvedValue({ items: [] }) };
    const controller = new CustomersController(service as never);

    await controller.list({ user: { id: 'user-1' } } as never, {
      page: '2',
      pageSize: '20',
      search: ' 客户 ',
      status: 'ACTIVE',
    });

    expect(service.list).toHaveBeenCalledWith('user-1', {
      page: 2,
      pageSize: 20,
      search: '客户',
      status: 'ACTIVE',
      sortBy: 'updatedAt',
      sortOrder: 'desc',
    });
  });

  it('rejects unknown body fields before calling the service', async () => {
    const service = { create: vi.fn(), update: vi.fn() };
    const controller = new CustomersController(service as never);
    const request = { user: { id: 'user-1' } } as never;

    expect(() =>
      controller.create(request, {
        projectId: 'project-1',
        number: 'C-1',
        name: '客户',
        actorId: 'attacker',
      } as never),
    ).toThrow(BadRequestException);
    expect(() =>
      controller.update(request, 'customer-1', { version: 1, projects: [] } as never),
    ).toThrow(BadRequestException);
    expect(service.create).not.toHaveBeenCalled();
    expect(service.update).not.toHaveBeenCalled();
  });

  it('takes contact ownership from the customer route and rejects unknown fields', () => {
    const service = { createContact: vi.fn() };
    const controller = new CustomersController(service as never);
    const request = { user: { id: 'user-1' } } as never;

    expect(() =>
      controller.createContact(request, 'customer-1', {
        version: 1,
        name: '联系人',
        customerId: 'customer-2',
      } as never),
    ).toThrow(BadRequestException);
    expect(service.createContact).not.toHaveBeenCalled();
  });

  it('routes contact listing through the authenticated parent customer', () => {
    const service = { listContacts: vi.fn().mockResolvedValue([]) };
    const controller = new CustomersController(service as never);
    const request = { user: { id: 'user-1' } } as never;

    controller.listContacts(request, 'customer-1');
    expect(service.listContacts).toHaveBeenCalledWith('user-1', 'customer-1');
  });
});
