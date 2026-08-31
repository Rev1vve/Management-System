import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import ProjectsPage from './page';

const apiMocks = vi.hoisted(() => ({
  listProjects: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  api: {
    listProjects: apiMocks.listProjects,
  },
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/projects',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={String(href)} {...props}>
      {children}
    </a>
  ),
}));

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ProjectsPage />
    </QueryClientProvider>,
  );
}

describe('ProjectsPage', () => {
  it('renders only projects returned by the scoped API list', async () => {
    apiMocks.listProjects.mockResolvedValue({
      items: [
        {
          id: 'project-1',
          number: 'PRJ-0001',
          name: '内部系统升级',
          status: 'ACTIVE',
          completionPercent: 25,
          version: 3,
          updatedAt: '2026-08-22T00:00:00.000Z',
          customer: { id: 'customer-1', number: 'CUST-0001', name: '客户甲' },
          portfolio: null,
        },
      ],
      page: 1,
      pageSize: 20,
      total: 1,
      totalPages: 1,
    });

    renderPage();

    await waitFor(() => {
      expect(apiMocks.listProjects).toHaveBeenCalledWith({
        page: 1,
        pageSize: 20,
        search: '',
        status: '',
      });
    });
    expect(await screen.findByRole('cell', { name: 'PRJ-0001' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '内部系统升级' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '客户甲' })).toBeInTheDocument();
    const table = screen.getByRole('table', { name: '项目列表' });
    expect(table).toHaveClass('min-w-[640px]');
    expect(table.parentElement).toHaveClass('overflow-x-auto');
    expect(screen.getByRole('columnheader', { name: '名称' })).toHaveAttribute('scope', 'col');
    expect(screen.queryByText('功能准备中')).not.toBeInTheDocument();
    expect(screen.queryByText(/另一个项目|示例项目/)).not.toBeInTheDocument();
  });
});
