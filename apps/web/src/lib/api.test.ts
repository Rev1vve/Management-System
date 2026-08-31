import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import { api } from './api';
import type { OrderCreate } from './api';

afterEach(() => vi.unstubAllGlobals());

function response(body: unknown, status = 200) {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('business API client', () => {
  it('restricts the new-order contract to the DRAFT initial state', () => {
    expectTypeOf<OrderCreate['status']>().toEqualTypeOf<'DRAFT' | undefined>();
  });

  it('serializes URL-backed customer list filters with the default page size', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(response({ items: [], page: 2, pageSize: 20, total: 0, totalPages: 0 }));
    vi.stubGlobal('fetch', fetchMock);

    await api.listCustomers({ page: 2, search: '甲 乙', status: 'ACTIVE' });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/customers?page=2&pageSize=20&search=%E7%94%B2+%E4%B9%99&status=ACTIVE',
      expect.objectContaining({ credentials: 'same-origin' }),
    );
  });

  it('uses one typed REST contract for detail, writes, archive, members and order items', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(response({ ok: true })));
    vi.stubGlobal('fetch', fetchMock);

    await api.getCustomer('customer / 1');
    await api.createPortfolio({ name: '交付项目集', description: null });
    await api.updateProject('project-1', { name: '项目甲', version: 2 });
    await api.archiveOrder('project-1', 'order-1', { version: 4 });
    await api.addProjectMember('project-1', { userId: 'user-1', roles: ['MEMBER'] });
    await api.createOrderItem('project-1', 'order-1', {
      version: 4,
      name: '实施',
      quantity: 1,
      unit: null,
    });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/v1/customers/customer%20%2F%201',
      '/api/v1/portfolios',
      '/api/v1/projects/project-1',
      '/api/v1/projects/project-1/orders/order-1/archive',
      '/api/v1/projects/project-1/members',
      '/api/v1/projects/project-1/orders/order-1/items',
    ]);
    expect(fetchMock.mock.calls.map(([, init]) => init.method ?? 'GET')).toEqual([
      'GET',
      'POST',
      'PATCH',
      'POST',
      'POST',
      'POST',
    ]);
  });

  it('supports protected customer contract attachment upload, download and archive without permanent URLs', async () => {
    const file = new File(['contract'], '客户 合同.pdf', { type: 'application/pdf' });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          items: [
            {
              id: 'attachment-1',
              originalName: '客户 合同.pdf',
              mimeType: 'application/pdf',
              sizeBytes: 8,
              status: 'ACTIVE',
              createdAt: '2026-08-22T00:00:00Z',
            },
          ],
          canManage: true,
        }),
      )
      .mockResolvedValueOnce(response({ id: 'attachment-1' }))
      .mockResolvedValueOnce(
        new Response('contract', {
          status: 200,
          headers: { 'Content-Disposition': 'attachment; filename="contract.pdf"' },
        }),
      )
      .mockResolvedValueOnce(response(null, 204));
    vi.stubGlobal('fetch', fetchMock);

    const listed = await api.listCustomerContractAttachments('customer-1');
    await api.uploadCustomerContractAttachment('customer-1', file);
    const downloaded = await api.downloadCustomerContractAttachment('customer-1', 'attachment / 1');
    await api.archiveCustomerContractAttachment('customer-1', 'attachment-1');

    expect(listed.items[0]).not.toHaveProperty('url');
    expect(downloaded.blob.size).toBe(8);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/v1/customers/customer-1/contract-attachments',
      '/api/v1/customers/customer-1/contract-attachments',
      '/api/v1/customers/customer-1/contract-attachments/attachment%20%2F%201/download',
      '/api/v1/customers/customer-1/contract-attachments/attachment-1/archive',
    ]);
    const uploadInit = fetchMock.mock.calls[1]![1] as RequestInit;
    expect(uploadInit.body).toBeInstanceOf(FormData);
    expect(new Headers(uploadInit.headers).has('Content-Type')).toBe(false);
  });

  it('keeps contact reads and writes nested under the routed customer id', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(response([])));
    vi.stubGlobal('fetch', fetchMock);

    await api.listCustomerContacts('customer / 1');
    await api.createCustomerContact('customer / 1', {
      version: 1,
      name: '联系人',
      isPrimary: false,
    });
    await api.updateCustomerContact('customer / 1', 'contact / 1', {
      version: 2,
      name: '联系人甲',
    });
    await api.archiveCustomerContact('customer / 1', 'contact / 1', { version: 3 });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/v1/customers/customer%20%2F%201/contacts',
      '/api/v1/customers/customer%20%2F%201/contacts',
      '/api/v1/customers/customer%20%2F%201/contacts/contact%20%2F%201',
      '/api/v1/customers/customer%20%2F%201/contacts/contact%20%2F%201/archive',
    ]);
  });

  it.each([401, 403, 404, 409])(
    'preserves HTTP status %s for honest UI messages',
    async (status) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ message: '拒绝' }, status)));
      await expect(api.getOrder('project-1', 'order-1')).rejects.toMatchObject({
        status,
        message: '拒绝',
        name: 'ApiError',
      });
    },
  );
});
