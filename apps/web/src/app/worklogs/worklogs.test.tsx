import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import WorkLogDetailPage from './[workLogId]/page';
import NewWorkLogPage from './new/page';
import MyWorkLogsPage from './page';

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  listMyWorkLogs: vi.fn(),
  listProjects: vi.fn(),
  createWorkLog: vi.fn(),
  getWorkLog: vi.fn(),
  updateWorkLogDraft: vi.fn(),
  addWorkLogVersion: vi.fn(),
  listWorkLogAttachments: vi.fn(),
  submitWorkLog: vi.fn(),
  setWorkLogVisibility: vi.fn(),
  uploadWorkLogAttachment: vi.fn(),
  archiveWorkLogAttachment: vi.fn(),
  workLogAttachmentDownloadUrl: (id: string) => `/api/v1/work-logs/${id}/download`,
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/worklogs',
  useRouter: () => ({ push: mocks.push }),
  useParams: () => ({ workLogId: 'wl-1' }),
}));
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
      listMyWorkLogs: mocks.listMyWorkLogs,
      listProjects: mocks.listProjects,
      createWorkLog: mocks.createWorkLog,
      getWorkLog: mocks.getWorkLog,
      updateWorkLogDraft: mocks.updateWorkLogDraft,
      addWorkLogVersion: mocks.addWorkLogVersion,
      listWorkLogAttachments: mocks.listWorkLogAttachments,
      submitWorkLog: mocks.submitWorkLog,
      setWorkLogVisibility: mocks.setWorkLogVisibility,
      uploadWorkLogAttachment: mocks.uploadWorkLogAttachment,
      archiveWorkLogAttachment: mocks.archiveWorkLogAttachment,
      workLogAttachmentDownloadUrl: mocks.workLogAttachmentDownloadUrl,
    },
  };
});

function renderWithQuery(element: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
}

const detail = {
  id: 'wl-1',
  number: 'WL-20261106-ABCD',
  status: 'DRAFT' as const,
  visibility: 'PRIVATE' as const,
  version: 3,
  projectId: 'project-1',
  currentVersion: {
    id: 'wlv-1',
    versionNumber: 1,
    workDate: '2026-11-06T00:00:00.000Z',
    hours: '4.5',
    completion: '完成需求梳理',
    progressNote: null,
    submittedAt: '2026-11-06T01:00:00.000Z',
  },
  versions: [{ id: 'wlv-1', versionNumber: 1, submittedAt: '2026-11-06T01:00:00.000Z' }],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listMyWorkLogs.mockResolvedValue({
    items: [
      {
        id: 'wl-1',
        number: 'WL-20261106-ABCD',
        status: 'DRAFT',
        visibility: 'PRIVATE',
        version: 3,
        project: { id: 'project-1', number: 'PRJ-1', name: '客户门户' },
        currentVersion: {
          versionNumber: 1,
          workDate: '2026-11-06T00:00:00.000Z',
          hours: '4.5',
          submittedAt: '2026-11-06T01:00:00.000Z',
        },
      },
    ],
    page: 1,
    pageSize: 20,
    total: 1,
  });
  mocks.listProjects.mockResolvedValue({ items: [], page: 1, pageSize: 100, total: 0 });
  mocks.getWorkLog.mockResolvedValue(detail);
  mocks.listWorkLogAttachments.mockResolvedValue([]);
});

describe('work log pages', () => {
  it('lists my logs with status, visibility and version', async () => {
    renderWithQuery(<MyWorkLogsPage />);

    expect(await screen.findByRole('link', { name: 'WL-20261106-ABCD' })).toHaveAttribute(
      'href',
      '/worklogs/wl-1',
    );
    expect(screen.getByText('草稿')).toBeInTheDocument();
    expect(screen.getByText('仅本人')).toBeInTheDocument();
    expect(screen.getByText('v1')).toBeInTheDocument();
    expect(screen.getByText('共 1 条，第 1 页')).toBeInTheDocument();
  });

  it('shows an honest empty state when there are no logs', async () => {
    mocks.listMyWorkLogs.mockResolvedValue({ items: [], page: 1, pageSize: 20, total: 0 });
    renderWithQuery(<MyWorkLogsPage />);

    expect(await screen.findByText('还没有工作日志')).toBeInTheDocument();
  });

  it('creates a draft and routes to its detail page', async () => {
    mocks.listProjects.mockResolvedValue({
      items: [{ id: 'project-1', number: 'PRJ-1', name: '客户门户' }],
      page: 1,
      pageSize: 100,
      total: 1,
    });
    mocks.createWorkLog.mockResolvedValue({
      id: 'wl-2',
      number: 'WL-2',
      versionNumber: 1,
      version: 1,
    });
    const user = userEvent.setup();
    renderWithQuery(<NewWorkLogPage />);

    await screen.findByRole('option', { name: /客户门户/ });
    await user.selectOptions(screen.getByLabelText(/项目/), 'project-1');
    await user.type(screen.getByLabelText(/工作日期/), '2026-11-06');
    await user.clear(screen.getByLabelText(/工时/));
    await user.type(screen.getByLabelText(/工时/), '4.5');
    await user.type(screen.getByLabelText(/完成内容/), '完成需求梳理');
    await user.click(screen.getByRole('button', { name: '保存草稿' }));

    await waitFor(() =>
      expect(mocks.createWorkLog).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'project-1',
          workDate: '2026-11-06',
          hours: 4.5,
          completion: '完成需求梳理',
        }),
      ),
    );
    expect(mocks.push).toHaveBeenCalledWith('/worklogs/wl-2');
  });

  it('shows the optimistic token and only offers submit while the log is a draft', async () => {
    renderWithQuery(<WorkLogDetailPage />);

    expect(await screen.findByRole('heading', { name: 'WL-20261106-ABCD' })).toBeInTheDocument();
    expect(screen.getByText(/乐观并发令牌 v3/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '提交审批' })).toBeInTheDocument();
    expect(screen.getByText('完成需求梳理')).toBeInTheDocument();
  });

  it('creates a new version through the version endpoint when the log was returned', async () => {
    mocks.getWorkLog.mockResolvedValue({ ...detail, status: 'RETURNED' });
    mocks.addWorkLogVersion.mockResolvedValue({
      id: 'wl-1',
      status: 'DRAFT',
      versionNumber: 2,
      version: 4,
    });
    const user = userEvent.setup();
    renderWithQuery(<WorkLogDetailPage />);

    await screen.findByRole('heading', { name: 'WL-20261106-ABCD' });
    expect(screen.getByText(/已退回修改/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '保存为新版本' }));

    await waitFor(() => expect(mocks.addWorkLogVersion).toHaveBeenCalledOnce());
    expect(mocks.updateWorkLogDraft).not.toHaveBeenCalled();
  });

  it('saves draft edits through the optimistic-token endpoint', async () => {
    mocks.updateWorkLogDraft.mockResolvedValue({ id: 'wl-1', status: 'DRAFT', version: 4 });
    const user = userEvent.setup();
    renderWithQuery(<WorkLogDetailPage />);

    await screen.findByRole('heading', { name: 'WL-20261106-ABCD' });
    await user.click(screen.getByRole('button', { name: '保存修改' }));

    await waitFor(() =>
      expect(mocks.updateWorkLogDraft).toHaveBeenCalledWith(
        'wl-1',
        expect.objectContaining({ version: 3, completion: '完成需求梳理' }),
      ),
    );
  });

  it('surfaces an attachment loading failure instead of pretending there are none', async () => {
    mocks.listWorkLogAttachments.mockRejectedValue(new Error('boom'));
    renderWithQuery(<WorkLogDetailPage />);

    await screen.findByRole('heading', { name: 'WL-20261106-ABCD' });
    expect(await screen.findByText(/无法加载附件/)).toBeInTheDocument();
    expect(screen.queryByText('暂无附件')).not.toBeInTheDocument();
  });

  it('shows the server validation message for a rejected approver', async () => {
    const { ApiError } = await import('@/lib/api');
    mocks.submitWorkLog.mockRejectedValue(
      new ApiError('审批人必须持有审批人角色或审批决策能力', 400),
    );
    const user = userEvent.setup();
    renderWithQuery(<WorkLogDetailPage />);

    await screen.findByRole('heading', { name: 'WL-20261106-ABCD' });
    await user.type(screen.getByLabelText(/指定审批人/), 'plain-member');
    await user.click(screen.getByRole('button', { name: '提交审批' }));

    expect(await screen.findByText('审批人必须持有审批人角色或审批决策能力')).toBeInTheDocument();
  });

  it('refreshes the log after a 409 so a stale token cannot trap the user', async () => {
    const { ApiError } = await import('@/lib/api');
    mocks.submitWorkLog.mockRejectedValue(new ApiError('conflict', 409));
    const user = userEvent.setup();
    renderWithQuery(<WorkLogDetailPage />);

    await screen.findByRole('heading', { name: 'WL-20261106-ABCD' });
    expect(mocks.getWorkLog).toHaveBeenCalledTimes(1);
    await user.type(screen.getByLabelText(/指定审批人/), 'approver-1');
    await user.click(screen.getByRole('button', { name: '提交审批' }));

    await waitFor(() => expect(mocks.getWorkLog).toHaveBeenCalledTimes(2));
  });

  it('shows the server message when a draft edit is rejected with 400', async () => {
    const { ApiError } = await import('@/lib/api');
    mocks.updateWorkLogDraft.mockRejectedValue(new ApiError('hours 必须大于 0 且不超过 24', 400));
    const user = userEvent.setup();
    renderWithQuery(<WorkLogDetailPage />);

    await screen.findByRole('heading', { name: 'WL-20261106-ABCD' });
    await user.click(screen.getByRole('button', { name: '保存修改' }));

    expect(await screen.findByText('hours 必须大于 0 且不超过 24')).toBeInTheDocument();
  });

  it('shows the approver-related server message for a 404 instead of a missing-log claim', async () => {
    const { ApiError } = await import('@/lib/api');
    mocks.submitWorkLog.mockRejectedValue(new ApiError('审批人不存在或不是项目当前成员', 404));
    const user = userEvent.setup();
    renderWithQuery(<WorkLogDetailPage />);

    await screen.findByRole('heading', { name: 'WL-20261106-ABCD' });
    await user.type(screen.getByLabelText(/指定审批人/), 'ghost-user');
    await user.click(screen.getByRole('button', { name: '提交审批' }));

    expect(await screen.findByText('审批人不存在或不是项目当前成员')).toBeInTheDocument();
    expect(screen.queryByText(/工作日志不存在或已被删除/)).not.toBeInTheDocument();
  });

  it('locks the visibility control after the server rejects with 403', async () => {
    const { ApiError } = await import('@/lib/api');
    mocks.setWorkLogVisibility.mockRejectedValue(new ApiError('无权限设置工作日志可见性', 403));
    const user = userEvent.setup();
    renderWithQuery(<WorkLogDetailPage />);

    await screen.findByRole('heading', { name: 'WL-20261106-ABCD' });
    await user.selectOptions(screen.getByLabelText(/可见性/), 'PROJECT_VISIBLE');

    expect(await screen.findByText(/无修改权限/)).toBeInTheDocument();
    // 控件降级为只读文本后，不应再存在可交互的下拉框。
    expect(screen.queryByRole('combobox', { name: /可见性/ })).not.toBeInTheDocument();
  });

  it('hides the submit action once the log left DRAFT', async () => {
    mocks.getWorkLog.mockResolvedValue({ ...detail, status: 'SUBMITTED' });
    renderWithQuery(<WorkLogDetailPage />);

    await screen.findByRole('heading', { name: 'WL-20261106-ABCD' });
    expect(screen.queryByRole('button', { name: '提交审批' })).not.toBeInTheDocument();
    expect(screen.getByText(/内容已冻结/)).toBeInTheDocument();
  });
});
