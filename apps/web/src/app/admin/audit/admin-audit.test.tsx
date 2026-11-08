import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import AdminAuditPage from './page';

const mocks = vi.hoisted(() => ({ listAudit: vi.fn() }));

vi.mock('next/navigation', () => ({ usePathname: () => '/admin/audit' }));
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={String(href)} {...props}>
      {children}
    </a>
  ),
}));
vi.mock('@/lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/api')>();
  return { ...original, api: { ...original.api, listAudit: mocks.listAudit } };
});

function renderWithQuery(element: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
}

const row = {
  id: 'log-1',
  actorId: 'admin-1',
  action: 'user.roles.changed',
  resourceType: 'USER',
  resourceId: 'user-1',
  projectId: null,
  result: 'SUCCESS',
  summary: '角色变更为 EXECUTIVE',
  createdAt: '2026-11-08T02:00:00.000Z',
  actor: { id: 'admin-1', name: '管理员' },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listAudit.mockResolvedValue({
    items: [row],
    page: 1,
    pageSize: 20,
    total: 1,
    timezone: 'Australia/Melbourne',
  });
});

describe('admin audit page', () => {
  it('renders audit rows read-only with the business timezone', async () => {
    renderWithQuery(<AdminAuditPage />);

    expect(await screen.findByText('user.roles.changed')).toBeInTheDocument();
    // 时间必须按业务时区显示：02:00Z 在 Melbourne 是 13:00。
    expect(screen.getByText(/13:00:00/)).toBeInTheDocument();
    expect(screen.getByText('管理员')).toBeInTheDocument();
    expect(screen.getByText(/Australia\/Melbourne/)).toBeInTheDocument();
    // 只读：没有编辑/删除入口——按钮和链接都不允许出现。
    expect(screen.queryByRole('button', { name: /删除|编辑/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /删除|编辑/ })).not.toBeInTheDocument();
  });

  it('passes the action filter to the API', async () => {
    const user = userEvent.setup();
    renderWithQuery(<AdminAuditPage />);

    await screen.findByText('user.roles.changed');
    await user.type(screen.getByLabelText('动作'), 'user.status.changed');

    await waitFor(() =>
      expect(mocks.listAudit).toHaveBeenLastCalledWith(
        expect.objectContaining({ action: 'user.status.changed' }),
      ),
    );
  });

  it('surfaces a server 400 without offering a retry', async () => {
    const { ApiError } = await import('@/lib/api');
    mocks.listAudit.mockRejectedValue(new ApiError('日期不存在', 400));
    renderWithQuery(<AdminAuditPage />);

    expect(await screen.findByText('查询条件不合法')).toBeInTheDocument();
    expect(screen.getByText('日期不存在')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '重新加载' })).not.toBeInTheDocument();
  });

  it('blocks an inverted range before querying', async () => {
    const user = userEvent.setup();
    renderWithQuery(<AdminAuditPage />);
    await screen.findByText('user.roles.changed');
    mocks.listAudit.mockClear();

    await user.type(screen.getByLabelText('起始日期'), '2026-11-08');
    await user.type(screen.getByLabelText('结束日期'), '2026-11-01');

    expect(await screen.findByText('起始日期不能晚于结束日期。')).toBeInTheDocument();
    expect(screen.queryByText('正在加载审计记录')).not.toBeInTheDocument();
  });

  it('formats timestamps in whatever timezone the server reports', async () => {
    mocks.listAudit.mockResolvedValue({
      items: [row],
      page: 1,
      pageSize: 20,
      total: 1,
      timezone: 'Asia/Tokyo',
    });
    renderWithQuery(<AdminAuditPage />);

    // 硬编码成 Melbourne 就会显示 13:00，这里必须是东京的 11:00。
    expect(await screen.findByText(/11:00:00/)).toBeInTheDocument();
    expect(screen.queryByText(/13:00:00/)).not.toBeInTheDocument();
  });

  it('hides stale rows while the range is invalid', async () => {
    const user = userEvent.setup();
    renderWithQuery(<AdminAuditPage />);
    await screen.findByText('user.roles.changed');

    await user.type(screen.getByLabelText('起始日期'), '2026-11-08');
    await user.type(screen.getByLabelText('结束日期'), '2026-11-01');

    expect(await screen.findByText('起始日期不能晚于结束日期。')).toBeInTheDocument();
    expect(screen.queryByText('user.roles.changed')).not.toBeInTheDocument();
  });

  it('distinguishes "no records yet" from "no matches for these filters"', async () => {
    mocks.listAudit.mockResolvedValue({
      items: [],
      page: 1,
      pageSize: 20,
      total: 0,
      timezone: 'Australia/Melbourne',
    });
    renderWithQuery(<AdminAuditPage />);

    expect(await screen.findByText('系统还没有写入任何审计记录。')).toBeInTheDocument();
  });
});
