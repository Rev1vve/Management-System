import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import AdminUsersPage from './page';

const mocks = vi.hoisted(() => ({
  listAdminUsers: vi.fn(),
  listAdminRoles: vi.fn(),
  setUserStatus: vi.fn(),
  setUserRoles: vi.fn(),
}));

vi.mock('next/navigation', () => ({ usePathname: () => '/admin/users' }));
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
      listAdminUsers: mocks.listAdminUsers,
      listAdminRoles: mocks.listAdminRoles,
      setUserStatus: mocks.setUserStatus,
      setUserRoles: mocks.setUserRoles,
    },
  };
});

function renderWithQuery(element: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
}

const userRow = {
  id: 'user-1',
  account: 'alice',
  name: 'Alice',
  workEmail: 'alice@example.test',
  status: 'ACTIVE' as const,
  mfaEnabled: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  roles: [{ key: 'EMPLOYEE', name: '普通员工' }],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listAdminUsers.mockResolvedValue({ items: [userRow], page: 1, pageSize: 20, total: 1 });
  mocks.listAdminRoles.mockResolvedValue([
    {
      key: 'EMPLOYEE',
      name: '普通员工',
      description: null,
      requiresMfa: false,
      permissions: ['worklog:manage'],
    },
    {
      key: 'EXECUTIVE',
      name: '高层领导',
      description: null,
      requiresMfa: true,
      permissions: ['report:view-all'],
    },
  ]);
  mocks.setUserStatus.mockResolvedValue({ id: 'user-1', status: 'SUSPENDED' });
  mocks.setUserRoles.mockResolvedValue({ id: 'user-1', roles: ['EMPLOYEE'] });
});

describe('admin users page', () => {
  it('lists users with status, MFA and roles but no credential fields', async () => {
    renderWithQuery(<AdminUsersPage />);

    expect(await screen.findByText('alice')).toBeInTheDocument();
    expect(screen.getByText('启用')).toBeInTheDocument();
    expect(screen.getByText('已启用')).toBeInTheDocument();
    expect(screen.getByText('普通员工')).toBeInTheDocument();
    expect(screen.queryByText(/passwordHash/)).not.toBeInTheDocument();
  });

  it('suspends an active account through the API', async () => {
    const user = userEvent.setup();
    renderWithQuery(<AdminUsersPage />);

    await user.click(await screen.findByRole('button', { name: '停用' }));

    await waitFor(() => expect(mocks.setUserStatus).toHaveBeenCalledWith('user-1', 'SUSPENDED'));
    expect(await screen.findByText(/全部会话已吊销/)).toBeInTheDocument();
  });

  it('shows MFA requirement next to privileged roles and explains the gate', async () => {
    const user = userEvent.setup();
    renderWithQuery(<AdminUsersPage />);

    await user.click(await screen.findByRole('button', { name: '改角色' }));

    expect(await screen.findByText('高层领导')).toBeInTheDocument();
    expect(screen.getByText('需要双因素认证')).toBeInTheDocument();
    expect(screen.getByText(/未启用双因素的用户不能获得需要 MFA 的角色/)).toBeInTheDocument();
  });

  it('saves the selected roles', async () => {
    const user = userEvent.setup();
    renderWithQuery(<AdminUsersPage />);

    await user.click(await screen.findByRole('button', { name: '改角色' }));
    await user.click(screen.getByRole('checkbox', { name: /高层领导/ }));
    await user.click(screen.getByRole('button', { name: '保存角色' }));

    await waitFor(() =>
      expect(mocks.setUserRoles).toHaveBeenCalledWith('user-1', ['EMPLOYEE', 'EXECUTIVE']),
    );
  });

  it('surfaces the server refusal instead of hiding the action', async () => {
    const { ApiError } = await import('@/lib/api');
    mocks.setUserStatus.mockRejectedValue(new ApiError('不能修改自己的账号状态', 403));
    const user = userEvent.setup();
    renderWithQuery(<AdminUsersPage />);

    await user.click(await screen.findByRole('button', { name: '停用' }));

    expect(await screen.findByText('不能修改自己的账号状态')).toBeInTheDocument();
  });

  it('shows an honest empty state for a search with no matches', async () => {
    mocks.listAdminUsers.mockResolvedValue({ items: [], page: 1, pageSize: 20, total: 0 });
    renderWithQuery(<AdminUsersPage />);

    expect(await screen.findByText('没有匹配的用户')).toBeInTheDocument();
  });

  it('does not claim a session revocation when enabling an account', async () => {
    mocks.listAdminUsers.mockResolvedValue({
      items: [{ ...userRow, status: 'SUSPENDED' }],
      page: 1,
      pageSize: 20,
      total: 1,
    });
    mocks.setUserStatus.mockResolvedValue({ id: 'user-1', status: 'ACTIVE' });
    const user = userEvent.setup();
    renderWithQuery(<AdminUsersPage />);

    await user.click(await screen.findByRole('button', { name: '启用' }));

    expect(await screen.findByText(/需要重新登录/)).toBeInTheDocument();
    expect(screen.queryByText(/会话已吊销/)).not.toBeInTheDocument();
  });

  it('keeps the list visible when an action is refused', async () => {
    const { ApiError } = await import('@/lib/api');
    mocks.setUserStatus.mockRejectedValue(new ApiError('不能修改自己的账号状态', 403));
    const user = userEvent.setup();
    renderWithQuery(<AdminUsersPage />);

    await user.click(await screen.findByRole('button', { name: '停用' }));

    expect(await screen.findByText('不能修改自己的账号状态')).toBeInTheDocument();
    // 失败不能把表格清空（用户还得能继续看/操作其他人）。
    expect(screen.getByText('alice')).toBeInTheDocument();
  });

  it('blocks saving roles when the catalogue failed to load', async () => {
    mocks.listAdminRoles.mockRejectedValue(new Error('boom'));
    const user = userEvent.setup();
    renderWithQuery(<AdminUsersPage />);

    await user.click(await screen.findByRole('button', { name: '改角色' }));

    expect(await screen.findByText(/角色清单加载失败/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '保存角色' })).toBeDisabled();
  });

  it('keeps saving disabled while the role catalogue is still loading', async () => {
    mocks.listAdminRoles.mockImplementation(() => new Promise(() => {}));
    const user = userEvent.setup();
    renderWithQuery(<AdminUsersPage />);

    await user.click(await screen.findByRole('button', { name: '改角色' }));

    expect(await screen.findByText('正在加载角色')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '保存角色' })).toBeDisabled();
  });

  it('does not show a success message next to an error', async () => {
    const { ApiError } = await import('@/lib/api');
    mocks.setUserStatus.mockRejectedValue(new ApiError('不能修改自己的账号状态', 403));
    const user = userEvent.setup();
    renderWithQuery(<AdminUsersPage />);

    await user.click(await screen.findByRole('button', { name: '停用' }));

    expect(await screen.findByText('不能修改自己的账号状态')).toBeInTheDocument();
    // 有错误时不显示成功提示，避免"看起来成功了但其实失败"。
    expect(screen.queryByText(/会话已吊销/)).not.toBeInTheDocument();
    expect(screen.queryByText(/需要重新登录/)).not.toBeInTheDocument();
  });
});
