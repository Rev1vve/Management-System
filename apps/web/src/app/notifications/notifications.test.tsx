import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import NotificationsPage from './page';

const mocks = vi.hoisted(() => ({
  listNotifications: vi.fn(),
  markNotificationRead: vi.fn(),
}));

vi.mock('next/navigation', () => ({ usePathname: () => '/notifications' }));
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
      listNotifications: mocks.listNotifications,
      markNotificationRead: mocks.markNotificationRead,
    },
  };
});

function renderWithQuery(element: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
}

const unread = {
  id: 'n-1',
  eventType: 'WORK_LOG_RETURNED',
  resourceType: 'WORK_LOG',
  resourceId: 'wl-1',
  title: '工作日志 WL-20261106-ABCD',
  body: '审批退回：补充进度',
  status: 'UNREAD' as const,
  readAt: null,
  createdAt: '2026-11-06T02:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listNotifications.mockResolvedValue({
    items: [unread],
    page: 1,
    pageSize: 20,
    total: 1,
    unread: 1,
  });
  mocks.markNotificationRead.mockResolvedValue({ ok: true });
});

describe('notifications page', () => {
  it('shows the notification with its body, unread count and work-log link', async () => {
    renderWithQuery(<NotificationsPage />);

    expect(await screen.findByText('工作日志 WL-20261106-ABCD')).toBeInTheDocument();
    expect(screen.getByText('审批退回：补充进度')).toBeInTheDocument();
    expect(screen.getByText('未读 1 条')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '查看工作日志' })).toHaveAttribute(
      'href',
      '/worklogs/wl-1',
    );
  });

  it('marks an unread notification as read', async () => {
    const user = userEvent.setup();
    renderWithQuery(<NotificationsPage />);

    await user.click(await screen.findByRole('button', { name: '标记已读' }));

    await waitFor(() => expect(mocks.markNotificationRead).toHaveBeenCalledWith('n-1'));
  });

  it('does not offer a mark-read button for already read rows', async () => {
    mocks.listNotifications.mockResolvedValue({
      items: [{ ...unread, status: 'READ', readAt: '2026-11-06T03:00:00.000Z' }],
      page: 1,
      pageSize: 20,
      total: 1,
      unread: 0,
    });
    renderWithQuery(<NotificationsPage />);

    await screen.findByText('工作日志 WL-20261106-ABCD');
    expect(screen.queryByRole('button', { name: '标记已读' })).not.toBeInTheDocument();
    expect(screen.getByText(/^已读 ·/)).toBeInTheDocument();
  });

  it('filters to unread only when toggled', async () => {
    const user = userEvent.setup();
    renderWithQuery(<NotificationsPage />);

    await user.click(await screen.findByRole('button', { name: '只看未读' }));

    await waitFor(() =>
      expect(mocks.listNotifications).toHaveBeenLastCalledWith(
        expect.objectContaining({ unreadOnly: true }),
      ),
    );
  });

  it('keeps a way back when the current page runs empty', async () => {
    mocks.listNotifications.mockResolvedValue({
      items: [],
      page: 2,
      pageSize: 20,
      total: 21,
      unread: 0,
    });
    renderWithQuery(<NotificationsPage />);

    expect(await screen.findByText('本页没有通知了')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '回到第一页' })).toBeInTheDocument();
  });

  it('exposes the unread filter state', async () => {
    renderWithQuery(<NotificationsPage />);

    const toggle = await screen.findByRole('button', { name: '只看未读' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
  });

  it('shows an honest empty state', async () => {
    mocks.listNotifications.mockResolvedValue({
      items: [],
      page: 1,
      pageSize: 20,
      total: 0,
      unread: 0,
    });
    renderWithQuery(<NotificationsPage />);

    expect(await screen.findByText('还没有通知')).toBeInTheDocument();
  });
});
