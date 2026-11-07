import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import DashboardPage from './page';

vi.mock('next/navigation', () => ({ usePathname: () => '/dashboard' }));
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
      reportSummary: vi.fn().mockResolvedValue({
        scope: 'OWN',
        range: { from: '2026-11-01', to: '2026-11-07', timezone: 'Australia/Melbourne' },
        hours: { total: 0, truncated: false, truncatedReason: null, limit: 5000 },
        approvals: {
          pending: 0,
          pendingAsOf: '2026-11-08',
          decided: { approved: 0, returned: 0, rejected: 0 },
          returnRate: 0,
        },
        projects: { inScope: 0 },
      }),
      listMyWorkLogs: vi.fn().mockResolvedValue({ items: [], page: 1, pageSize: 5, total: 0 }),
      listApprovals: vi.fn().mockResolvedValue({ items: [], page: 1, pageSize: 3, total: 0 }),
      listNotifications: vi
        .fn()
        .mockResolvedValue({ items: [], page: 1, pageSize: 3, total: 0, unread: 0 }),
    },
  };
});

describe('/dashboard route', () => {
  it('renders the real dashboard, not a placeholder', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <DashboardPage />
      </QueryClientProvider>,
    );

    expect(await screen.findByRole('heading', { name: '工作台' })).toBeInTheDocument();
    expect(screen.queryByText('暂未开放')).not.toBeInTheDocument();
  });
});
