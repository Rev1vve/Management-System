import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import CustomerDetailPage from './page';

const mocks = vi.hoisted(() => ({
  getCustomer: vi.fn(),
  updateCustomer: vi.fn(),
  archiveCustomer: vi.fn(),
  listContacts: vi.fn(),
  createContact: vi.fn(),
  updateContact: vi.fn(),
  archiveContact: vi.fn(),
  listAttachments: vi.fn(),
  uploadAttachment: vi.fn(),
  downloadAttachment: vi.fn(),
  archiveAttachment: vi.fn(),
  push: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useParams: () => ({ customerId: 'customer-1' }),
  usePathname: () => '/customers/customer-1',
  useRouter: () => ({ push: mocks.push }),
}));
vi.mock('@/lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...original,
    api: {
      ...original.api,
      getCustomer: mocks.getCustomer,
      updateCustomer: mocks.updateCustomer,
      archiveCustomer: mocks.archiveCustomer,
      listCustomerContacts: mocks.listContacts,
      createCustomerContact: mocks.createContact,
      updateCustomerContact: mocks.updateContact,
      archiveCustomerContact: mocks.archiveContact,
      listCustomerContractAttachments: mocks.listAttachments,
      uploadCustomerContractAttachment: mocks.uploadAttachment,
      downloadCustomerContractAttachment: mocks.downloadAttachment,
      archiveCustomerContractAttachment: mocks.archiveAttachment,
    },
  };
});
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={String(href)} {...props}>
      {children}
    </a>
  ),
}));

function renderPage() {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <CustomerDetailPage />
    </QueryClientProvider>,
  );
}
const customer = {
  id: 'customer-1',
  number: 'C-001',
  name: '真实客户',
  status: 'ACTIVE' as const,
  version: 2,
  updatedAt: '2026-08-22T00:00:00Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCustomer.mockResolvedValue(customer);
  mocks.listContacts.mockResolvedValue([]);
  mocks.listAttachments.mockResolvedValue({ items: [], canManage: false });
});

describe('CustomerDetailPage', () => {
  it('loads the route customer and renders only fields returned by the API', async () => {
    renderPage();
    expect(screen.getByRole('status')).toHaveTextContent('正在加载客户');
    expect(await screen.findByRole('heading', { name: '真实客户' })).toBeInTheDocument();
    expect(mocks.getCustomer).toHaveBeenCalledWith('customer-1');
    expect(screen.getByText('C-001')).toBeInTheDocument();
    expect(screen.queryByText(/示例|虚构/)).not.toBeInTheDocument();
  });

  it('keeps every write entry hidden unless the relevant API response explicitly grants management', async () => {
    renderPage();
    await screen.findByRole('heading', { name: '真实客户' });
    expect(screen.queryByRole('button', { name: '编辑客户' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '归档客户' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('上传合同附件')).not.toBeInTheDocument();
  });

  it('never exposes edit or archive actions for an archived customer', async () => {
    mocks.getCustomer.mockResolvedValue({
      ...customer,
      name: '已归档客户',
      status: 'ARCHIVED',
      canManage: true,
    });
    renderPage();
    expect(await screen.findByRole('heading', { name: '已归档客户' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '编辑客户' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '归档客户' })).not.toBeInTheDocument();
  });

  it('updates editable fields with the current version when canManage is true', async () => {
    const user = userEvent.setup();
    mocks.getCustomer.mockResolvedValue({ ...customer, canManage: true });
    mocks.updateCustomer.mockResolvedValue({
      ...customer,
      name: '新客户名',
      version: 3,
      canManage: true,
    });
    renderPage();
    await user.click(await screen.findByRole('button', { name: '编辑客户' }));
    expect(screen.queryByRole('option', { name: '已归档' })).not.toBeInTheDocument();
    const name = screen.getByLabelText('客户名称');
    await user.clear(name);
    await user.type(name, '新客户名');
    await user.click(screen.getByRole('button', { name: '保存客户' }));
    await waitFor(() =>
      expect(mocks.updateCustomer).toHaveBeenCalledWith('customer-1', {
        number: 'C-001',
        name: '新客户名',
        status: 'ACTIVE',
        version: 2,
      }),
    );
  });

  it('renders contacts and creates a contact only when the server grants management', async () => {
    const user = userEvent.setup();
    mocks.getCustomer.mockResolvedValue({ ...customer, version: 4, canManage: true });
    mocks.listContacts.mockResolvedValue([
      {
        id: 'contact-1',
        customerId: 'customer-1',
        name: '联系人甲',
        workEmail: 'contact@example.test',
        phone: null,
        position: '经理',
        isPrimary: true,
      },
    ]);
    mocks.createContact.mockResolvedValue({
      id: 'contact-2',
      customerId: 'customer-1',
      name: '联系人乙',
      isPrimary: false,
    });
    renderPage();

    expect(await screen.findByText(/联系人甲/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '新增联系人' }));
    await user.type(screen.getByLabelText('联系人姓名'), '联系人乙');
    await user.click(screen.getByRole('button', { name: '保存联系人' }));

    await waitFor(() =>
      expect(mocks.createContact).toHaveBeenCalledWith('customer-1', {
        version: 4,
        name: '联系人乙',
        workEmail: null,
        phone: null,
        position: null,
        isPrimary: false,
      }),
    );
  });
});
