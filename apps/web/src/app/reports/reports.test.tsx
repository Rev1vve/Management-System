import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ReportsPage from './page';

const mocks = vi.hoisted(() => ({
  reportSummary: vi.fn(),
  reportByProject: vi.fn(),
  reportDrilldown: vi.fn(),
}));

vi.mock('next/navigation', () => ({ usePathname: () => '/reports' }));
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
      reportSummary: mocks.reportSummary,
      reportByProject: mocks.reportByProject,
      reportDrilldown: mocks.reportDrilldown,
    },
  };
});

function renderWithQuery(element: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
}

const summary = {
  scope: 'PROJECTS' as const,
  range: { from: '2026-11-01', to: '2026-11-07', timezone: 'Australia/Melbourne' },
  hours: { total: 12.5, truncated: false, truncatedReason: null, limit: 5000 },
  approvals: {
    pending: 3,
    pendingAsOf: '2026-11-07',
    decided: { approved: 6, returned: 2, rejected: 2 },
    returnRate: 0.2,
  },
  projects: { inScope: 2, withActivity: 1 },
};

const projectRow = {
  projectId: 'project-1',
  number: 'PRJ-1',
  name: '客户门户',
  hours: 6.5,
  approved: 6,
  returned: 2,
  rejected: 2,
  returnRate: 0.2,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.reportSummary.mockResolvedValue(summary);
  mocks.reportByProject.mockResolvedValue({
    range: summary.range,
    items: [projectRow],
    truncated: false,
    truncatedReasons: [],
    limit: 5000,
  });
  mocks.reportDrilldown.mockResolvedValue({
    range: summary.range,
    items: [
      {
        workLogId: 'wl-1',
        number: 'WL-20261106-ABCD',
        status: 'APPROVED',
        author: { id: 'author-1', name: '张三' },
        versionNumber: 2,
        workDate: '2026-11-06T00:00:00.000Z',
        hours: 3,
        completion: '完成接口联调',
      },
    ],
    truncated: false,
    limit: 200,
  });
});

describe('reports page', () => {
  it('shows the aggregate metrics with the business timezone and pending snapshot', async () => {
    renderWithQuery(<ReportsPage />);

    expect(await screen.findByText('12.5 h')).toBeInTheDocument();
    expect(screen.getByText('待审（实时）')).toBeInTheDocument();
    expect(screen.getByText(/快照 2026-11-07/)).toBeInTheDocument();
    expect(screen.getByText('审批结果')).toBeInTheDocument();
    expect(screen.getByText('通过 6 · 退回 2 · 拒绝 2')).toBeInTheDocument();
    // 汇总卡与表头都有'退回率'、数值可能重复，这里只确认汇总卡渲染了数值。
    expect(screen.getAllByText('退回率').length).toBeGreaterThan(0);
    expect(screen.getAllByText('20%').length).toBeGreaterThan(0);
    expect(screen.getByText(/Australia\/Melbourne/)).toBeInTheDocument();
    // 两个数字分开显示：作用域大小 vs 本区间有记录的项目数。
    expect(screen.getByText(/范围内项目 2 个/)).toBeInTheDocument();
    expect(screen.getByText(/本区间有记录 1 个/)).toBeInTheDocument();
  });

  it('lists per-project rows and fetches the drilldown on demand', async () => {
    const user = userEvent.setup();
    renderWithQuery(<ReportsPage />);

    expect(await screen.findByText('客户门户')).toBeInTheDocument();
    expect(mocks.reportDrilldown).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '查看明细' }));

    expect(await screen.findByText('完成接口联调')).toBeInTheDocument();
    expect(screen.getByText('张三')).toBeInTheDocument();
    expect(mocks.reportDrilldown).toHaveBeenCalledWith('project-1', {
      from: undefined,
      to: undefined,
    });
  });

  it('states honestly that drilldown needs a separate capability', async () => {
    const { ApiError } = await import('@/lib/api');
    mocks.reportDrilldown.mockRejectedValue(new ApiError('无权限查看报表明细', 403));
    const user = userEvent.setup();
    renderWithQuery(<ReportsPage />);

    await user.click(await screen.findByRole('button', { name: '查看明细' }));

    expect(await screen.findByText('没有下钻权限')).toBeInTheDocument();
    expect(screen.getByText(/需要单独授予「报表下钻」能力/)).toBeInTheDocument();
  });

  it('surfaces the server message for an invalid range instead of asking to retry', async () => {
    const { ApiError } = await import('@/lib/api');
    mocks.reportSummary.mockRejectedValue(new ApiError('起始日期必须早于结束日期', 400));
    renderWithQuery(<ReportsPage />);

    expect(await screen.findByText('日期区间不合法')).toBeInTheDocument();
    expect(screen.getByText('起始日期必须早于结束日期')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '重新加载' })).not.toBeInTheDocument();
  });

  it('blocks obviously inverted ranges before querying', async () => {
    const user = userEvent.setup();
    renderWithQuery(<ReportsPage />);
    await screen.findByText('12.5 h');
    mocks.reportSummary.mockClear();

    await user.type(screen.getByLabelText('起始日期'), '2026-11-07');
    await user.type(screen.getByLabelText('结束日期'), '2026-11-01');

    expect(await screen.findByText('起始日期不能晚于结束日期。')).toBeInTheDocument();
    // 区间非法时不应假装还在加载。
    expect(screen.queryByText('正在加载报表')).not.toBeInTheDocument();
    expect(screen.queryByText('正在加载项目汇总')).not.toBeInTheDocument();
    // 只在区间非法期间不再发起请求（此前的合法区间请求不算）。
    const callsAfter = mocks.reportSummary.mock.calls.map(
      (call) => call[0] as { from?: string; to?: string },
    );
    expect(callsAfter.every((arg) => !(arg.from && arg.to && arg.from > arg.to))).toBe(true);
  });

  it('warns when the hours figure hit the row limit', async () => {
    mocks.reportSummary.mockResolvedValue({
      ...summary,
      hours: { total: 12.5, truncated: true, truncatedReason: 'ROW_LIMIT', limit: 5000 },
    });
    renderWithQuery(<ReportsPage />);

    expect(await screen.findByText(/当前数字可能偏小/)).toBeInTheDocument();
  });

  it('names the actual limit when drilldown rows are truncated', async () => {
    mocks.reportDrilldown.mockResolvedValue({
      range: summary.range,
      items: [
        {
          workLogId: 'wl-1',
          number: 'WL-1',
          status: 'APPROVED',
          author: { id: 'author-1', name: '张三' },
          versionNumber: 2,
          workDate: '2026-11-06T00:00:00.000Z',
          hours: 3,
          completion: '完成接口联调',
        },
      ],
      truncated: true,
      limit: 37,
    });
    const user = userEvent.setup();
    renderWithQuery(<ReportsPage />);

    await user.click(await screen.findByRole('button', { name: '查看明细' }));
    expect(await screen.findByText(/仅显示最近 37 条/)).toBeInTheDocument();
  });

  it('distinguishes decision truncation from work-log truncation', async () => {
    mocks.reportByProject.mockResolvedValue({
      range: summary.range,
      items: [projectRow],
      truncated: true,
      truncatedReasons: ['DECISION_ROW_LIMIT'],
      limit: 5000,
    });
    renderWithQuery(<ReportsPage />);

    expect(await screen.findByText(/退回率可能偏低/)).toBeInTheDocument();
    expect(screen.queryByText(/工时可能偏小/)).not.toBeInTheDocument();
  });

  it('refetches with the chosen range', async () => {
    const user = userEvent.setup();
    renderWithQuery(<ReportsPage />);

    await screen.findByText('12.5 h');
    await user.type(screen.getByLabelText('起始日期'), '2026-11-01');
    await user.type(screen.getByLabelText('结束日期'), '2026-11-07');

    await waitFor(() =>
      expect(mocks.reportSummary).toHaveBeenLastCalledWith({
        from: '2026-11-01',
        to: '2026-11-07',
      }),
    );
  });

  it('warns when a result was truncated instead of pretending it is complete', async () => {
    mocks.reportByProject.mockResolvedValue({
      range: summary.range,
      items: [projectRow],
      truncated: true,
      truncatedReasons: ['WORK_LOG_ROW_LIMIT'],
      limit: 5000,
    });
    renderWithQuery(<ReportsPage />);

    expect(await screen.findByText(/工时可能偏小/)).toBeInTheDocument();
  });
});
