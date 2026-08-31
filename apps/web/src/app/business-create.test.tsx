import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import CustomerCreatePage from './customers/new/page';
import PortfolioCreatePage from './portfolios/new/page';
import ProjectCreatePage from './projects/new/page';

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  listCustomers: vi.fn(),
  listPortfolios: vi.fn(),
  listProjects: vi.fn(),
  createCustomer: vi.fn(),
  createPortfolio: vi.fn(),
  createProject: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({ push: mocks.push }),
}));
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={String(href)} {...props}>
      {children}
    </a>
  ),
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
      createCustomer: mocks.createCustomer,
      createPortfolio: mocks.createPortfolio,
      createProject: mocks.createProject,
    },
  };
});

function renderPage(Page: React.ComponentType) {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}
    >
      <Page />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  const allowed = { items: [], page: 1, pageSize: 1, total: 0, totalPages: 0, canManage: true };
  mocks.listCustomers.mockResolvedValue(allowed);
  mocks.listPortfolios.mockResolvedValue(allowed);
  mocks.listProjects.mockResolvedValue(allowed);
});

describe('task 7 collection creation pages', () => {
  it('creates a customer only in the explicitly entered managed project scope', async () => {
    const user = userEvent.setup();
    mocks.createCustomer.mockResolvedValue({ id: 'c1' });
    renderPage(CustomerCreatePage);
    await user.type(await screen.findByLabelText('项目 ID'), 'pr1');
    await user.type(screen.getByLabelText('客户编号'), 'C-1');
    await user.type(screen.getByLabelText('客户名称'), '客户甲');
    await user.click(screen.getByRole('button', { name: '创建客户' }));
    await waitFor(() =>
      expect(mocks.createCustomer).toHaveBeenCalledWith({
        projectId: 'pr1',
        number: 'C-1',
        name: '客户甲',
      }),
    );
    expect(mocks.push).toHaveBeenCalledWith('/customers/c1');
  });

  it('creates a portfolio through the typed API and navigates to its detail', async () => {
    const user = userEvent.setup();
    mocks.createPortfolio.mockResolvedValue({ id: 'pf1' });
    renderPage(PortfolioCreatePage);
    await user.type(await screen.findByLabelText('项目集名称'), '组合甲');
    await user.type(screen.getByLabelText('说明'), '内部组合');
    await user.click(screen.getByRole('button', { name: '创建项目集' }));
    await waitFor(() =>
      expect(mocks.createPortfolio).toHaveBeenCalledWith({
        name: '组合甲',
        description: '内部组合',
      }),
    );
    expect(mocks.push).toHaveBeenCalledWith('/portfolios/pf1');
  });

  it('creates a project without inventing optional resource references', async () => {
    const user = userEvent.setup();
    mocks.createProject.mockResolvedValue({ id: 'pr1' });
    renderPage(ProjectCreatePage);
    await user.type(await screen.findByLabelText('项目编号'), 'PR-1');
    await user.type(screen.getByLabelText('项目名称'), '项目甲');
    await user.click(screen.getByRole('button', { name: '创建项目' }));
    await waitFor(() =>
      expect(mocks.createProject).toHaveBeenCalledWith(
        expect.objectContaining({
          number: 'PR-1',
          name: '项目甲',
          customerId: null,
          portfolioId: null,
        }),
      ),
    );
    expect(mocks.push).toHaveBeenCalledWith('/projects/pr1');
  });

  it.each([
    ['客户', CustomerCreatePage, mocks.listCustomers, '创建客户'],
    ['项目集', PortfolioCreatePage, mocks.listPortfolios, '创建项目集'],
    ['项目', ProjectCreatePage, mocks.listProjects, '创建项目'],
  ] as const)(
    'does not render the %s creation form unless the collection API explicitly grants capability',
    async (_name, Page, capabilityQuery, submitLabel) => {
      capabilityQuery.mockResolvedValue({
        items: [],
        page: 1,
        pageSize: 1,
        total: 0,
        totalPages: 0,
        canManage: false,
      });
      renderPage(Page);
      expect(await screen.findByText(/你无权新建/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: submitLabel })).not.toBeInTheDocument();
    },
  );
});
