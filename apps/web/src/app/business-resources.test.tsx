import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import CustomersPage from './customers/page';
import OrdersPage from './orders/page';
import PortfoliosPage from './portfolios/page';
import ProjectsPage from './projects/page';
import { ApiError } from '@/lib/api';

const mocks = vi.hoisted(() => ({
  listCustomers: vi.fn(),
  listPortfolios: vi.fn(),
  listProjects: vi.fn(),
  listOrders: vi.fn(),
  search: new URLSearchParams(),
  push: vi.fn(),
}));
vi.mock('@/lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...original,
    api: {
      ...original.api,
      listCustomers: mocks.listCustomers,
      listPortfolios: mocks.listPortfolios,
      listProjects: mocks.listProjects,
      listOrders: mocks.listOrders,
    },
  };
});
vi.mock('next/navigation', () => ({
  usePathname: () => '/resource',
  useSearchParams: () => mocks.search,
  useRouter: () => ({ push: mocks.push, replace: vi.fn(), back: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={String(href)} {...props}>
      {children}
    </a>
  ),
}));

function renderPage(Page: React.ComponentType) {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <Page />
    </QueryClientProvider>,
  );
}
afterEach(() => {
  vi.clearAllMocks();
  mocks.search = new URLSearchParams();
  document.body.innerHTML = '';
});

const empty = { items: [], page: 1, pageSize: 20, total: 0, totalPages: 0 };

describe('task 7 business resource lists', () => {
  it('customers uses URL page/search/status, semantic table and API-only rows', async () => {
    mocks.search = new URLSearchParams('page=2&search=%E7%94%B2&status=ACTIVE');
    mocks.listCustomers.mockResolvedValue({
      ...empty,
      page: 2,
      items: [
        {
          id: 'c1',
          number: 'C-001',
          name: '真实客户甲',
          status: 'ACTIVE',
          version: 1,
          updatedAt: '2026-08-22',
        },
      ],
      total: 1,
      totalPages: 2,
    });
    renderPage(CustomersPage);
    await waitFor(() =>
      expect(mocks.listCustomers).toHaveBeenCalledWith({
        page: 2,
        pageSize: 20,
        search: '甲',
        status: 'ACTIVE',
      }),
    );
    expect(await screen.findByRole('cell', { name: '真实客户甲' })).toBeInTheDocument();
    expect(screen.getByRole('table', { name: '客户列表' }).parentElement).toHaveClass(
      'overflow-x-auto',
    );
    expect(screen.getByRole('columnheader', { name: '名称' })).toHaveAttribute('scope', 'col');
    expect(screen.queryByText(/示例客户|功能准备中/)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /新建客户/ })).not.toBeInTheDocument();
  });

  it('customers has loading, empty and honest forbidden states', async () => {
    mocks.listCustomers.mockReturnValue(new Promise(() => {}));
    const loading = renderPage(CustomersPage);
    expect(screen.getByRole('status')).toHaveTextContent('正在加载客户');
    loading.unmount();
    mocks.listCustomers.mockResolvedValueOnce(empty);
    renderPage(CustomersPage);
    expect(await screen.findByText('暂时没有可查看的客户')).toBeInTheDocument();
    mocks.listCustomers.mockRejectedValueOnce(new ApiError('no', 403));
    renderPage(CustomersPage);
    expect(await screen.findByText('你无权查看这些客户')).toBeInTheDocument();
  });

  it('portfolios renders only API data and supports empty state', async () => {
    mocks.listPortfolios.mockResolvedValue({
      ...empty,
      items: [
        {
          id: 'p1',
          name: '真实项目集',
          description: null,
          status: 'ACTIVE',
          updatedAt: '2026-08-22',
        },
      ],
      total: 1,
      totalPages: 1,
    });
    renderPage(PortfoliosPage);
    expect(await screen.findByRole('cell', { name: '真实项目集' })).toBeInTheDocument();
    expect(mocks.listPortfolios).toHaveBeenCalledWith({
      page: 1,
      pageSize: 20,
      search: '',
      status: '',
    });
    expect(screen.queryByText(/示例项目集|功能准备中/)).not.toBeInTheDocument();
  });

  it('shows collection create links only when the API explicitly grants capability', async () => {
    mocks.listCustomers.mockResolvedValue({ ...empty, canManage: true });
    const customers = renderPage(CustomersPage);
    expect(await screen.findByRole('link', { name: '新建客户' })).toHaveAttribute(
      'href',
      '/customers/new',
    );
    customers.unmount();

    mocks.listPortfolios.mockResolvedValue({ ...empty, canManage: true });
    const portfolios = renderPage(PortfoliosPage);
    expect(await screen.findByRole('link', { name: '新建项目集' })).toHaveAttribute(
      'href',
      '/portfolios/new',
    );
    portfolios.unmount();

    mocks.listProjects.mockResolvedValue({ ...empty, canManage: true });
    const projects = renderPage(ProjectsPage);
    expect(await screen.findByRole('link', { name: '新建项目' })).toHaveAttribute(
      'href',
      '/projects/new',
    );
    projects.unmount();

    mocks.search = new URLSearchParams('projectId=pr1');
    mocks.listOrders.mockResolvedValue({ ...empty, canManage: true });
    renderPage(OrdersPage);
    expect(await screen.findByRole('link', { name: '新建订单' })).toHaveAttribute(
      'href',
      '/projects/pr1/orders/new',
    );
  });

  it('keeps collection create links hidden when capability is absent or false', async () => {
    mocks.listProjects.mockResolvedValue({ ...empty, canManage: false });
    renderPage(ProjectsPage);
    await waitFor(() => expect(mocks.listProjects).toHaveBeenCalled());
    expect(screen.queryByRole('link', { name: '新建项目' })).not.toBeInTheDocument();
  });

  it('orders renders only scoped API data and uses a semantic locally scrolling table', async () => {
    mocks.search = new URLSearchParams('projectId=pr1');
    mocks.listOrders.mockResolvedValue({
      ...empty,
      items: [
        {
          id: 'o1',
          number: 'O-001',
          projectId: 'pr1',
          title: '真实订单',
          status: 'DRAFT',
          version: 1,
          updatedAt: '2026-08-22',
        },
      ],
      total: 1,
      totalPages: 1,
    });
    renderPage(OrdersPage);
    await waitFor(() =>
      expect(mocks.listOrders).toHaveBeenCalledWith('pr1', {
        page: 1,
        pageSize: 20,
        search: '',
        status: '',
      }),
    );
    expect(await screen.findByRole('cell', { name: '真实订单' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'pr1' })).toBeInTheDocument();
    expect(screen.getByRole('table', { name: '订单列表' }).parentElement).toHaveClass(
      'overflow-x-auto',
    );
    expect(screen.queryByText(/示例订单|功能准备中/)).not.toBeInTheDocument();
  });
});
