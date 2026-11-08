import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import SettingsPage from './admin/settings/page';

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
  // /reports 与 /admin/users、/admin/audit 都已是真实页面，只剩系统设置这一个占位页。
  it.each([['系统设置', SettingsPage]])(
    'renders %s as a productized preparing state',
    (heading, Page) => {
      const { container } = render(<Page />);

      expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument();
      expect(screen.getByText('功能准备中')).toBeInTheDocument();
      expect(
        screen.getByText('数据服务启用后，这里会显示你有权限访问的信息。'),
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /尚未开放/ })).toBeDisabled();
      expect(screen.getByRole('table', { name: `${heading}列表` })).toBeInTheDocument();
      expect(screen.getByRole('searchbox', { name: `搜索${heading}` })).toBeDisabled();
      expect(container).not.toHaveTextContent(/页面骨架|任务\s*\d+|后续任务|API 尚未|接口将在/);
    },
  );

  it('does not treat a page requirement as the current user role', () => {
    render(<SettingsPage />);

    expect(screen.getByRole('heading', { name: '系统设置' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '系统设置' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '报表' })).not.toBeInTheDocument();
  });
});
