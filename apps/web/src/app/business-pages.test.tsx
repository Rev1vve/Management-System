import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import CustomersPage from './customers/page';
import ProjectsPage from './projects/page';
import ReportsPage from './reports/page';
import UsersPage from './admin/users/page';

const navigationMocks = vi.hoisted(() => ({ pathname: '/customers' }));

vi.mock('next/navigation', () => ({
  usePathname: () => navigationMocks.pathname,
}));

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={String(href)} {...props}>
      {children}
    </a>
  ),
}));

describe('business page wireframes', () => {
  it.each([
    ['客户', CustomersPage],
    ['项目', ProjectsPage],
    ['报表', ReportsPage],
    ['用户管理', UsersPage],
  ])('renders %s as a productized preparing state', (heading, Page) => {
    const { container } = render(<Page />);

    expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument();
    expect(screen.getByText('功能准备中')).toBeInTheDocument();
    expect(screen.getByText('数据服务启用后，这里会显示你有权限访问的信息。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /尚未开放/ })).toBeDisabled();
    expect(screen.getByRole('table', { name: `${heading}列表` })).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: `搜索${heading}` })).toBeDisabled();
    expect(container).not.toHaveTextContent(/页面骨架|任务\s*\d+|后续任务|API 尚未|接口将在/);
  });

  it('keeps long names contained in a semantic, locally scrollable table', () => {
    render(<ProjectsPage />);

    const table = screen.getByRole('table');
    expect(table).toHaveClass('min-w-[640px]');
    expect(table.parentElement).toHaveClass('overflow-x-auto');
    expect(screen.getByRole('columnheader', { name: '名称' })).toHaveAttribute('scope', 'col');
    expect(screen.queryByText(/Name|Description/)).not.toBeInTheDocument();
  });

  it('does not treat a page requirement as the current user role', () => {
    render(<ReportsPage />);

    expect(screen.getByRole('heading', { name: '报表' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '报表' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '用户管理' })).not.toBeInTheDocument();
  });
});
