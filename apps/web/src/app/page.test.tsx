import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import HomePage from './page';

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

vi.mock('next/navigation', () => ({
  usePathname: () => '/',
}));

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={String(href)} {...props}>
      {children}
    </a>
  ),
}));

describe('HomePage', () => {
  it('renders the responsibility dashboard without placeholder claims', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={client}>
        <HomePage />
      </QueryClientProvider>,
    );

    expect(await screen.findByRole('heading', { name: '工作台' })).toBeInTheDocument();
    // 首页已经是真实职责首页：不应再出现"暂未开放"之类的占位措辞。
    expect(screen.queryByText('暂未开放')).not.toBeInTheDocument();
    expect(container).not.toHaveTextContent(/后续任务|任务\s*\d+|API 尚未|完成.*API 后/);
  });
});
