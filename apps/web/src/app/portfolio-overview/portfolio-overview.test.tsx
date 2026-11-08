import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import PortfolioOverviewPage from './page';

const mocks = vi.hoisted(() => ({ reportPortfolios: vi.fn() }));

vi.mock('next/navigation', () => ({ usePathname: () => '/portfolio-overview' }));
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={String(href)} {...props}>
      {children}
    </a>
  ),
}));
vi.mock('@/lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/api')>();
  return { ...original, api: { ...original.api, reportPortfolios: mocks.reportPortfolios } };
});

function renderWithQuery(element: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.reportPortfolios.mockResolvedValue({
    range: { from: '2026-11-01', to: '2026-11-07', timezone: 'Australia/Melbourne' },
    items: [
      {
        portfolioId: 'pf-1',
        name: '政企线',
        projects: 3,
        hours: 12.5,
        approved: 4,
        returned: 1,
        rejected: 0,
        returnRate: 0.2,
      },
    ],
    portfoliosTotal: 1,
    truncated: false,
    truncatedReasons: [],
    limit: 5000,
  });
});

describe('portfolio overview page', () => {
  it('shows aggregate rows for the portfolios the server returned', async () => {
    renderWithQuery(<PortfolioOverviewPage />);

    expect(await screen.findByText('政企线')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('12.5 h')).toBeInTheDocument();
    expect(screen.getByText('20%')).toBeInTheDocument();
  });

  it('states honestly when there is no portfolio membership', async () => {
    mocks.reportPortfolios.mockResolvedValue({
      range: { from: '2026-11-01', to: '2026-11-07', timezone: 'Australia/Melbourne' },
      items: [],
      portfoliosTotal: 0,
      truncated: false,
      truncatedReasons: [],
      limit: 5000,
    });
    renderWithQuery(<PortfolioOverviewPage />);

    expect(await screen.findByText('你还不属于任何项目集')).toBeInTheDocument();
  });

  it('surfaces a load failure instead of an empty overview', async () => {
    mocks.reportPortfolios.mockRejectedValue(new Error('boom'));
    renderWithQuery(<PortfolioOverviewPage />);

    expect(await screen.findByText(/无法加载项目集/)).toBeInTheDocument();
    expect(screen.queryByText('你还不属于任何项目集')).not.toBeInTheDocument();
  });

  it('distinguishes "no membership" from "membership without live projects"', async () => {
    mocks.reportPortfolios.mockResolvedValue({
      range: { from: '2026-11-01', to: '2026-11-07', timezone: 'Australia/Melbourne' },
      items: [],
      portfoliosTotal: 2,
      truncated: false,
      truncatedReasons: [],
      limit: 5000,
    });
    renderWithQuery(<PortfolioOverviewPage />);

    expect(await screen.findByText('所属项目集下暂无进行中的项目')).toBeInTheDocument();
    expect(screen.queryByText('你还不属于任何项目集')).not.toBeInTheDocument();
  });

  it('warns when portfolio aggregation was truncated', async () => {
    mocks.reportPortfolios.mockResolvedValue({
      range: { from: '2026-11-01', to: '2026-11-07', timezone: 'Australia/Melbourne' },
      items: [
        {
          portfolioId: 'pf-1',
          name: '政企线',
          projects: 3,
          hours: 12.5,
          approved: 4,
          returned: 1,
          rejected: 0,
          returnRate: 0.2,
        },
      ],
      portfoliosTotal: 1,
      truncated: true,
      truncatedReasons: ['DECISION_ROW_LIMIT'],
      limit: 5000,
    });
    renderWithQuery(<PortfolioOverviewPage />);

    expect(await screen.findByText(/统计可能不完整/)).toBeInTheDocument();
  });
});
