import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DashboardView } from '@/components/dashboard/dashboard-view';

const mocks = vi.hoisted(() => ({
  reportSummary: vi.fn(),
  listMyWorkLogs: vi.fn(),
  listApprovals: vi.fn(),
  listNotifications: vi.fn(),
}));

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
      reportSummary: mocks.reportSummary,
      listMyWorkLogs: mocks.listMyWorkLogs,
      listApprovals: mocks.listApprovals,
      listNotifications: mocks.listNotifications,
    },
  };
});

function renderWithQuery(element: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
}

const summary = {
  scope: 'OWN' as const,
  range: { from: '2026-11-01', to: '2026-11-07', timezone: 'Australia/Melbourne' },
  hours: { total: 6.5, truncated: false, truncatedReason: null, limit: 5000 },
  approvals: {
    pending: 0,
    pendingAsOf: '2026-11-08',
    decided: { approved: 1, returned: 1, rejected: 0 },
    returnRate: 0.5,
  },
  projects: { inScope: 1 },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.reportSummary.mockResolvedValue(summary);
  mocks.listMyWorkLogs.mockResolvedValue({
    items: [
      {
        id: 'wl-1',
        number: 'WL-20261106-ABCD',
        status: 'RETURNED',
        visibility: 'PRIVATE',
        version: 2,
        project: { id: 'project-1', number: 'PRJ-1', name: '客户门户' },
        currentVersion: {
          versionNumber: 2,
          workDate: '2026-11-06T00:00:00.000Z',
          hours: '3',
          submittedAt: '2026-11-06T01:00:00.000Z',
        },
      },
    ],
    page: 1,
    pageSize: 5,
    total: 1,
  });
  mocks.listApprovals.mockResolvedValue({ items: [], page: 1, pageSize: 3, total: 0 });
  mocks.listNotifications.mockResolvedValue({
    items: [],
    page: 1,
    pageSize: 3,
    total: 0,
    unread: 2,
  });
});

describe('dashboard page', () => {
  it('shows scope-aware metrics and the live unread count', async () => {
    renderWithQuery(<DashboardView />);

    expect(await screen.findByText('我的工时')).toBeInTheDocument();
    expect(screen.getByText('6.5 h')).toBeInTheDocument();
    expect(screen.getByText('50%')).toBeInTheDocument();
    // 未读数来自服务端，即使列表为空也照实显示。
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText(/仅本人数据/)).toBeInTheDocument();
  });

  it('labels the team scope when the server reports cross-project data', async () => {
    mocks.reportSummary.mockResolvedValue({ ...summary, scope: 'PROJECTS' });
    renderWithQuery(<DashboardView />);

    expect(await screen.findByText('团队工时')).toBeInTheDocument();
    expect(screen.getByText(/授权项目汇总/)).toBeInTheDocument();
  });

  it('lists my recent work logs with status text and links', async () => {
    renderWithQuery(<DashboardView />);

    const link = await screen.findByRole('link', { name: 'WL-20261106-ABCD' });
    expect(link).toHaveAttribute('href', '/worklogs/wl-1');
    expect(screen.getByText(/退回修改/)).toBeInTheDocument();
  });

  it('shows honest empty states for pending approvals and notifications', async () => {
    renderWithQuery(<DashboardView />);

    expect(await screen.findByText('没有待办审批')).toBeInTheDocument();
    expect(screen.getByText('没有通知')).toBeInTheDocument();
  });

  it('surfaces a load failure instead of an empty dashboard', async () => {
    mocks.reportSummary.mockRejectedValue(new Error('boom'));
    renderWithQuery(<DashboardView />);

    expect(await screen.findByText(/无法加载工作台/)).toBeInTheDocument();
    expect(screen.queryByText('我的工时')).not.toBeInTheDocument();
  });

  it('warns when the hours figure was truncated', async () => {
    mocks.reportSummary.mockResolvedValue({
      ...summary,
      hours: { total: 6.5, truncated: true, truncatedReason: 'ROW_LIMIT', limit: 5000 },
    });
    renderWithQuery(<DashboardView />);

    expect(await screen.findByText(/数字可能偏小/)).toBeInTheDocument();
  });

  it('shows a dash, not zero, when a metric source failed', async () => {
    mocks.listNotifications.mockRejectedValue(new Error('boom'));
    renderWithQuery(<DashboardView />);

    expect(await screen.findByText(/无法加载通知/)).toBeInTheDocument();
    const unreadCard = screen.getByText('未读通知').closest('div');
    expect(unreadCard).toHaveTextContent('—');
    expect(unreadCard).not.toHaveTextContent('0');
  });

  it('takes the pending count from paging metadata, not from the visible rows', async () => {
    mocks.listApprovals.mockResolvedValue({
      items: [
        {
          id: 'approval-1',
          submittedAt: '2026-11-06T01:00:00.000Z',
          canDecide: true,
          workLogVersion: {
            id: 'wlv-1',
            versionNumber: 1,
            workDate: '2026-11-06T00:00:00.000Z',
            hours: '2',
            completion: '内容',
            workLog: {
              id: 'wl-1',
              number: 'WL-1',
              currentVersionId: 'wlv-1',
              project: { id: 'p1', number: 'PRJ-1', name: '客户门户' },
              author: { id: 'a1', name: '张三' },
            },
          },
        },
      ],
      page: 1,
      pageSize: 3,
      total: 7,
    });
    renderWithQuery(<DashboardView />);

    const card = (await screen.findByText('待办审批')).closest('div');
    expect(card).toHaveTextContent('7');
  });

  it('surfaces failures for each list instead of showing an empty state', async () => {
    mocks.listApprovals.mockRejectedValue(new Error('boom'));
    mocks.listMyWorkLogs.mockRejectedValue(new Error('boom'));
    renderWithQuery(<DashboardView />);

    expect(await screen.findByText(/无法加载待办审批/)).toBeInTheDocument();
    expect(screen.getByText(/无法加载工作日志/)).toBeInTheDocument();
    expect(screen.queryByText('没有待办审批')).not.toBeInTheDocument();
    expect(screen.queryByText('还没有工作日志')).not.toBeInTheDocument();
  });

  it('shows a dash for the pending card too when its source failed', async () => {
    mocks.listApprovals.mockRejectedValue(new Error('boom'));
    renderWithQuery(<DashboardView />);

    expect(await screen.findByText(/无法加载待办审批/)).toBeInTheDocument();
    const pendingCard = screen.getByText('待办审批').closest('div');
    expect(pendingCard).toHaveTextContent('—');
    expect(pendingCard).not.toHaveTextContent('0');
  });

  it('gives each metric link a distinct accessible name', async () => {
    renderWithQuery(<DashboardView />);

    expect(await screen.findByRole('link', { name: '查看我的工时' })).toHaveAttribute(
      'href',
      '/reports',
    );
    expect(screen.getByRole('link', { name: '查看待办审批' })).toHaveAttribute(
      'href',
      '/approvals',
    );
    expect(screen.getByRole('link', { name: '查看未读通知' })).toHaveAttribute(
      'href',
      '/notifications',
    );
  });
});
