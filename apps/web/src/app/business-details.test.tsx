import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import PortfolioDetailPage from './portfolios/[portfolioId]/page';
import ProjectDetailPage from './projects/[projectId]/page';
import OrderDetailPage from './projects/[projectId]/orders/[orderId]/page';
import ProjectEditPage from './projects/[projectId]/edit/page';
import OrderEditPage from './projects/[projectId]/orders/[orderId]/edit/page';
import OrderCreatePage from './projects/[projectId]/orders/new/page';

const mocks = vi.hoisted(() => ({
  params: {} as Record<string, string>,
  push: vi.fn(),
  getPortfolio: vi.fn(),
  updatePortfolio: vi.fn(),
  archivePortfolio: vi.fn(),
  getProject: vi.fn(),
  updateProject: vi.fn(),
  archiveProject: vi.fn(),
  listProjectMembers: vi.fn(),
  addProjectMember: vi.fn(),
  updateProjectMember: vi.fn(),
  removeProjectMember: vi.fn(),
  getOrder: vi.fn(),
  listOrders: vi.fn(),
  createOrder: vi.fn(),
  updateOrder: vi.fn(),
  archiveOrder: vi.fn(),
  listOrderItems: vi.fn(),
  createOrderItem: vi.fn(),
  updateOrderItem: vi.fn(),
  archiveOrderItem: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useParams: () => mocks.params,
  usePathname: () => '/',
  useRouter: () => ({ push: mocks.push }),
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
  return { ...original, api: { ...original.api, ...mocks } };
});
function renderPage(Page: React.ComponentType) {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <Page />
    </QueryClientProvider>,
  );
}
const project = {
  id: 'pr1',
  number: 'PR-1',
  name: '真实项目',
  status: 'ACTIVE' as const,
  completionPercent: 25,
  version: 3,
  updatedAt: '2026-08-22',
  customer: null,
  portfolio: null,
};
const order = {
  id: 'o1',
  projectId: 'pr1',
  number: 'O-1',
  title: '真实订单',
  status: 'DRAFT' as const,
  version: 2,
  updatedAt: '2026-08-22',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listProjectMembers.mockResolvedValue([]);
  mocks.listOrderItems.mockResolvedValue([]);
});

describe('task 7 business details', () => {
  it('portfolio uses route id and hides writes by default', async () => {
    mocks.params = { portfolioId: 'pf1' };
    mocks.getPortfolio.mockResolvedValue({
      id: 'pf1',
      name: '真实项目集',
      description: '说明',
      status: 'ACTIVE',
      updatedAt: '2026-08-22',
    });
    renderPage(PortfolioDetailPage);
    expect(await screen.findByRole('heading', { name: '真实项目集' })).toBeInTheDocument();
    expect(mocks.getPortfolio).toHaveBeenCalledWith('pf1');
    expect(screen.queryByRole('button', { name: '编辑项目集' })).not.toBeInTheDocument();
  });

  it('never exposes edit or archive actions for an archived portfolio', async () => {
    mocks.params = { portfolioId: 'pf1' };
    mocks.getPortfolio.mockResolvedValue({
      id: 'pf1',
      name: '已归档项目集',
      description: null,
      status: 'ARCHIVED',
      updatedAt: '2026-08-22',
      canManage: true,
    });
    renderPage(PortfolioDetailPage);
    expect(await screen.findByRole('heading', { name: '已归档项目集' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '编辑项目集' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '归档项目集' })).not.toBeInTheDocument();
  });

  it('portfolio submits only supported update fields when explicitly manageable', async () => {
    const user = userEvent.setup();
    mocks.params = { portfolioId: 'pf1' };
    mocks.getPortfolio.mockResolvedValue({
      id: 'pf1',
      name: '旧名',
      description: null,
      status: 'ACTIVE',
      updatedAt: '2026-08-22',
      canManage: true,
    });
    mocks.updatePortfolio.mockResolvedValue({
      id: 'pf1',
      name: '新名',
      status: 'ACTIVE',
      updatedAt: '2026-08-22',
      canManage: true,
    });
    renderPage(PortfolioDetailPage);
    await user.click(await screen.findByRole('button', { name: '编辑项目集' }));
    expect(screen.queryByRole('option', { name: '已归档' })).not.toBeInTheDocument();
    await user.clear(screen.getByLabelText('项目集名称'));
    await user.type(screen.getByLabelText('项目集名称'), '新名');
    await user.click(screen.getByRole('button', { name: '保存项目集' }));
    await waitFor(() =>
      expect(mocks.updatePortfolio).toHaveBeenCalledWith('pf1', {
        name: '新名',
        description: null,
        status: 'ACTIVE',
      }),
    );
    await waitFor(() => expect(mocks.getPortfolio).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('button', { name: '编辑项目集' })).toBeInTheDocument();
  });

  it('project loads members, links to project-scoped orders, and hides member writes by default', async () => {
    mocks.params = { projectId: 'pr1' };
    mocks.getProject.mockResolvedValue(project);
    mocks.listProjectMembers.mockResolvedValue([
      {
        id: 'm1',
        userId: 'u1',
        user: { id: 'u1', name: '成员甲', workEmail: 'a@example.com' },
        roles: [{ role: 'MEMBER' }],
      },
    ]);
    renderPage(ProjectDetailPage);
    expect(await screen.findByRole('heading', { name: '真实项目' })).toBeInTheDocument();
    expect(mocks.listProjectMembers).toHaveBeenCalledWith('pr1');
    expect(screen.getByRole('link', { name: '进入订单' })).toHaveAttribute(
      'href',
      '/orders?projectId=pr1',
    );
    expect(await screen.findByText('成员甲')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '添加成员' })).not.toBeInTheDocument();
  });

  it('manageable project can add a member with explicit roles', async () => {
    const user = userEvent.setup();
    mocks.params = { projectId: 'pr1' };
    mocks.getProject.mockResolvedValue({ ...project, canManage: true });
    mocks.addProjectMember.mockResolvedValue({});
    renderPage(ProjectDetailPage);
    await user.click(await screen.findByRole('button', { name: '添加成员' }));
    await user.type(screen.getByLabelText('用户 ID'), 'u2');
    await user.selectOptions(screen.getByLabelText('项目角色'), 'MEMBER');
    await user.click(screen.getByRole('button', { name: '保存成员' }));
    await waitFor(() =>
      expect(mocks.addProjectMember).toHaveBeenCalledWith('pr1', {
        userId: 'u2',
        roles: ['MEMBER'],
      }),
    );
  });

  it('order calls every client with projectId and renders semantic item table', async () => {
    mocks.params = { projectId: 'pr1', orderId: 'o1' };
    mocks.getOrder.mockResolvedValue(order);
    mocks.listOrderItems.mockResolvedValue([
      {
        id: 'i1',
        orderId: 'o1',
        name: '真实明细',
        quantity: 2,
        unit: '件',
        status: 'PENDING',
        sortOrder: 0,
      },
    ]);
    renderPage(OrderDetailPage);
    expect(await screen.findByRole('heading', { name: '真实订单' })).toBeInTheDocument();
    expect(mocks.getOrder).toHaveBeenCalledWith('pr1', 'o1');
    expect(mocks.listOrderItems).toHaveBeenCalledWith('pr1', 'o1');
    expect((await screen.findByRole('table', { name: '订单明细列表' })).parentElement).toHaveClass(
      'overflow-x-auto',
    );
    expect(screen.queryByRole('button', { name: '新增明细' })).not.toBeInTheDocument();
  });

  it('manageable order creates an item with the current parent order version', async () => {
    const user = userEvent.setup();
    mocks.params = { projectId: 'pr1', orderId: 'o1' };
    mocks.getOrder.mockResolvedValue({ ...order, canManage: true });
    mocks.createOrderItem.mockResolvedValue({});
    renderPage(OrderDetailPage);
    await user.click(await screen.findByRole('button', { name: '新增明细' }));
    await user.type(screen.getByLabelText('明细名称'), '实施服务');
    await user.clear(screen.getByLabelText('数量'));
    await user.type(screen.getByLabelText('数量'), '2');
    await user.click(screen.getByRole('button', { name: '保存明细' }));
    await waitFor(() =>
      expect(mocks.createOrderItem).toHaveBeenCalledWith(
        'pr1',
        'o1',
        expect.objectContaining({ version: 2, name: '实施服务', quantity: 2 }),
      ),
    );
  });

  it('does not offer another archive action for a cancelled order item', async () => {
    mocks.params = { projectId: 'pr1', orderId: 'o1' };
    mocks.getOrder.mockResolvedValue({ ...order, canManage: true });
    mocks.listOrderItems.mockResolvedValue([
      {
        id: 'i1',
        orderId: 'o1',
        name: '已取消明细',
        quantity: 1,
        unit: null,
        status: 'CANCELLED',
        sortOrder: 0,
      },
    ]);
    renderPage(OrderDetailPage);
    expect(await screen.findByText('已取消明细')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '归档明细' })).not.toBeInTheDocument();
  });

  it('does not render the order creation form unless the server grants project-scoped capability', async () => {
    mocks.params = { projectId: 'pr1' };
    mocks.getProject.mockResolvedValue(project);
    renderPage(OrderCreatePage);
    expect(await screen.findByText('你无权在此项目中新建订单')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '创建订单' })).not.toBeInTheDocument();
  });

  it('creates new orders only as DRAFT and does not offer later lifecycle states', async () => {
    const user = userEvent.setup();
    mocks.params = { projectId: 'pr1' };
    mocks.getProject.mockResolvedValue({ ...project, canManage: true });
    mocks.createOrder.mockResolvedValue({ ...order, id: 'o2' });

    renderPage(OrderCreatePage);
    await screen.findByLabelText('订单编号');
    expect(screen.getByText('初始状态：草稿')).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: '进行中' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: '已完成' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: '已取消' })).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('订单编号'), 'O-2');
    await user.type(screen.getByLabelText('订单名称'), '新订单');
    await user.click(screen.getByRole('button', { name: '创建订单' }));
    await waitFor(() =>
      expect(mocks.createOrder).toHaveBeenCalledWith(
        'pr1',
        expect.objectContaining({ number: 'O-2', title: '新订单', status: 'DRAFT' }),
      ),
    );
  });

  it('does not offer ARCHIVED as a normal order form status', async () => {
    mocks.params = { projectId: 'pr1', orderId: 'o1' };
    mocks.getOrder.mockResolvedValue({ ...order, canManage: true });
    renderPage(OrderEditPage);
    await screen.findByDisplayValue('真实订单');
    expect(screen.queryByRole('option', { name: '已归档' })).not.toBeInTheDocument();
  });

  it('project edit preloads API data and submits the current version', async () => {
    const user = userEvent.setup();
    mocks.params = { projectId: 'pr1' };
    mocks.getProject.mockResolvedValue({ ...project, canManage: true });
    mocks.updateProject.mockResolvedValue({ ...project, name: '更新项目', canManage: true });
    renderPage(ProjectEditPage);
    expect(await screen.findByDisplayValue('真实项目')).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: '已归档' })).not.toBeInTheDocument();
    await user.clear(screen.getByLabelText('项目名称'));
    await user.type(screen.getByLabelText('项目名称'), '更新项目');
    await user.click(screen.getByRole('button', { name: '保存项目' }));
    await waitFor(() =>
      expect(mocks.updateProject).toHaveBeenCalledWith(
        'pr1',
        expect.objectContaining({
          number: 'PR-1',
          name: '更新项目',
          status: 'ACTIVE',
          completionPercent: 25,
          version: 3,
        }),
      ),
    );
  });

  it('order edit and creation keep every request in the routed project scope', async () => {
    const user = userEvent.setup();
    mocks.params = { projectId: 'pr1', orderId: 'o1' };
    mocks.getOrder.mockResolvedValue({ ...order, canManage: true });
    mocks.updateOrder.mockResolvedValue({ ...order, title: '更新订单', canManage: true });
    const edit = renderPage(OrderEditPage);
    await screen.findByDisplayValue('真实订单');
    await user.clear(screen.getByLabelText('订单名称'));
    await user.type(screen.getByLabelText('订单名称'), '更新订单');
    await user.click(screen.getByRole('button', { name: '保存订单' }));
    await waitFor(() =>
      expect(mocks.updateOrder).toHaveBeenCalledWith(
        'pr1',
        'o1',
        expect.objectContaining({ number: 'O-1', title: '更新订单', version: 2 }),
      ),
    );
    edit.unmount();
    mocks.params = { projectId: 'pr1' };
    mocks.getProject.mockResolvedValue({ ...project, canManage: true });
    mocks.createOrder.mockResolvedValue({ ...order, id: 'o2' });
    renderPage(OrderCreatePage);
    await screen.findByLabelText('订单编号');
    await user.type(screen.getByLabelText('订单编号'), 'O-2');
    await user.type(screen.getByLabelText('订单名称'), '新订单');
    await user.click(screen.getByRole('button', { name: '创建订单' }));
    await waitFor(() =>
      expect(mocks.createOrder).toHaveBeenCalledWith(
        'pr1',
        expect.objectContaining({ number: 'O-2', title: '新订单' }),
      ),
    );
  });
});
