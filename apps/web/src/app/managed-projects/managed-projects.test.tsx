import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ManagedProjectsPage from './page';

const mocks = vi.hoisted(() => ({ reportManagedProjects: vi.fn() }));

vi.mock('next/navigation', () => ({ usePathname: () => '/managed-projects' }));
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
    api: { ...original.api, reportManagedProjects: mocks.reportManagedProjects },
  };
});

function renderWithQuery(element: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.reportManagedProjects.mockResolvedValue({
    range: { from: '2026-11-01', to: '2026-11-07', timezone: 'Australia/Melbourne' },
    items: [
      {
        projectId: 'project-1',
        number: 'PRJ-1',
        name: '客户门户',
        hours: 6.5,
        approved: 2,
        returned: 1,
        rejected: 0,
        returnRate: 1 / 3,
        status: 'ACTIVE',
        completionPercent: 40,
      },
    ],
    projectsManaged: 1,
    truncated: false,
    truncatedReasons: [],
    limit: 5000,
  });
});

describe('managed projects page', () => {
  it('lists only the projects the server says I manage', async () => {
    renderWithQuery(<ManagedProjectsPage />);

    expect(await screen.findByRole('link', { name: /客户门户/ })).toHaveAttribute(
      'href',
      '/projects/project-1',
    );
    expect(screen.getByText('进行中')).toBeInTheDocument();
    expect(screen.getByText('40%')).toBeInTheDocument();
    expect(screen.getByText('6.5 h')).toBeInTheDocument();
  });

  it('states honestly when the caller manages nothing', async () => {
    mocks.reportManagedProjects.mockResolvedValue({
      range: { from: '2026-11-01', to: '2026-11-07', timezone: 'Australia/Melbourne' },
      items: [],
      projectsManaged: 0,
      truncated: false,
      truncatedReasons: [],
      limit: 5000,
    });
    renderWithQuery(<ManagedProjectsPage />);

    expect(await screen.findByText('没有你管理的项目')).toBeInTheDocument();
  });

  it('warns when the aggregation was truncated', async () => {
    mocks.reportManagedProjects.mockResolvedValue({
      range: { from: '2026-11-01', to: '2026-11-07', timezone: 'Australia/Melbourne' },
      items: [
        {
          projectId: 'project-1',
          number: 'PRJ-1',
          name: '客户门户',
          hours: 6.5,
          approved: 0,
          returned: 0,
          rejected: 0,
          returnRate: 0,
          status: 'ACTIVE',
          completionPercent: 40,
        },
      ],
      projectsManaged: 1,
      truncated: true,
      truncatedReasons: ['WORK_LOG_ROW_LIMIT'],
      limit: 5000,
    });
    renderWithQuery(<ManagedProjectsPage />);

    expect(await screen.findByText(/统计可能不完整/)).toBeInTheDocument();
  });

  it('still lists a managed project that had no activity in the range', async () => {
    mocks.reportManagedProjects.mockResolvedValue({
      range: { from: '2026-11-01', to: '2026-11-07', timezone: 'Australia/Melbourne' },
      items: [
        {
          projectId: 'project-9',
          number: 'PRJ-9',
          name: '零活动项目',
          hours: 0,
          approved: 0,
          returned: 0,
          rejected: 0,
          returnRate: 0,
          status: 'ON_HOLD',
          completionPercent: 10,
        },
      ],
      projectsManaged: 1,
      truncated: false,
      truncatedReasons: [],
      limit: 5000,
    });
    renderWithQuery(<ManagedProjectsPage />);

    expect(await screen.findByRole('link', { name: /零活动项目/ })).toBeInTheDocument();
    expect(screen.getByText('0 h')).toBeInTheDocument();
    expect(screen.getByText('暂停')).toBeInTheDocument();
  });

  it('surfaces a load failure instead of an empty page', async () => {
    mocks.reportManagedProjects.mockRejectedValue(new Error('boom'));
    renderWithQuery(<ManagedProjectsPage />);

    expect(await screen.findByText(/无法加载所辖项目/)).toBeInTheDocument();
    expect(screen.queryByText('没有你管理的项目')).not.toBeInTheDocument();
  });
});
