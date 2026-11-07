import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ApprovalsPage from './page';

const mocks = vi.hoisted(() => ({
  listApprovals: vi.fn(),
  decideApproval: vi.fn(),
}));

vi.mock('next/navigation', () => ({ usePathname: () => '/approvals' }));
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
      listApprovals: mocks.listApprovals,
      decideApproval: mocks.decideApproval,
    },
  };
});

function renderWithQuery(element: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
}

const item = {
  id: 'approval-1',
  submittedAt: '2026-11-06T01:00:00.000Z',
  canDecide: true,
  workLogVersion: {
    id: 'wlv-1',
    versionNumber: 1,
    workDate: '2026-11-06T00:00:00.000Z',
    hours: '4.5',
    completion: '完成需求梳理',
    workLog: {
      id: 'wl-1',
      number: 'WL-20261106-ABCD',
      currentVersionId: 'wlv-1',
      project: { id: 'project-1', number: 'PRJ-1', name: '客户门户' },
      author: { id: 'author-1', name: '张三' },
    },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listApprovals.mockResolvedValue({ items: [item], page: 1, pageSize: 20, total: 1 });
  mocks.decideApproval.mockResolvedValue({
    id: 'approval-1',
    status: 'APPROVED',
    workLogStatus: 'APPROVED',
  });
});

describe('approvals page', () => {
  it('renders the pending request with its content and submitter', async () => {
    renderWithQuery(<ApprovalsPage />);

    expect(await screen.findByRole('link', { name: 'WL-20261106-ABCD' })).toHaveAttribute(
      'href',
      '/worklogs/wl-1',
    );
    expect(screen.getByText('完成需求梳理')).toBeInTheDocument();
    expect(screen.getByText(/张三 提交/)).toBeInTheDocument();
  });

  it('requires a comment before returning and never sends an empty one', async () => {
    const user = userEvent.setup();
    renderWithQuery(<ApprovalsPage />);

    await screen.findByRole('heading', { name: /WL-20261106-ABCD/ });
    await user.click(screen.getByRole('button', { name: '退回修改' }));

    const confirm = screen.getByRole('button', { name: '确认退回修改' });
    expect(confirm).toBeDisabled();
    expect(screen.getByText('退回或拒绝必须填写审批意见。')).toBeInTheDocument();
    expect(mocks.decideApproval).not.toHaveBeenCalled();
  });

  it('sends the decision with the typed comment', async () => {
    const user = userEvent.setup();
    renderWithQuery(<ApprovalsPage />);

    await screen.findByRole('heading', { name: /WL-20261106-ABCD/ });
    await user.click(screen.getByRole('button', { name: '退回修改' }));
    await user.type(screen.getByLabelText(/审批意见/), '请补充进度');
    await user.click(screen.getByRole('button', { name: '确认退回修改' }));

    await waitFor(() =>
      expect(mocks.decideApproval).toHaveBeenCalledWith('approval-1', {
        decision: 'RETURNED',
        comment: '请补充进度',
      }),
    );
  });

  it('disables actions when the request points at a stale version', async () => {
    mocks.listApprovals.mockResolvedValue({
      items: [{ ...item, canDecide: false }],
      page: 1,
      pageSize: 20,
      total: 1,
    });
    renderWithQuery(<ApprovalsPage />);

    await screen.findByRole('heading', { name: /WL-20261106-ABCD/ });
    expect(screen.getByText(/无法处理/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '通过' })).not.toBeInTheDocument();
  });

  it('keeps a way back when the current page runs empty', async () => {
    mocks.listApprovals.mockResolvedValue({ items: [], page: 2, pageSize: 20, total: 21 });
    const user = userEvent.setup();
    renderWithQuery(<ApprovalsPage />);

    expect(await screen.findByText('本页已经没有待办')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '回到第一页' }));
    await waitFor(() =>
      expect(mocks.listApprovals).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1 })),
    );
  });

  it('exposes the decision choice as a pressed-state group', async () => {
    renderWithQuery(<ApprovalsPage />);

    await screen.findByRole('heading', { name: /WL-20261106-ABCD/ });
    expect(screen.getByRole('group', { name: '选择审批结论' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '通过' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '退回修改' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('only shows the submitting state on the card being decided', async () => {
    const second = {
      ...item,
      id: 'approval-2',
      workLogVersion: {
        ...item.workLogVersion,
        workLog: { ...item.workLogVersion.workLog, id: 'wl-2', number: 'WL-20261106-EFGH' },
      },
    };
    mocks.listApprovals.mockResolvedValue({
      items: [item, second],
      page: 1,
      pageSize: 20,
      total: 2,
    });
    mocks.decideApproval.mockImplementation(() => new Promise(() => {}));
    const user = userEvent.setup();
    renderWithQuery(<ApprovalsPage />);

    await screen.findByRole('heading', { name: /WL-20261106-ABCD/ });
    await user.click(screen.getAllByRole('button', { name: '确认通过' })[0]!);

    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: '正在提交…' })).toHaveLength(1),
    );
  });

  it('shows an honest empty state', async () => {
    mocks.listApprovals.mockResolvedValue({ items: [], page: 1, pageSize: 20, total: 0 });
    renderWithQuery(<ApprovalsPage />);

    expect(await screen.findByText('没有待办审批')).toBeInTheDocument();
  });
});
