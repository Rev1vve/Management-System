import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppShell } from './app-shell';

const navigationMocks = vi.hoisted(() => ({
  pathname: '/projects',
}));

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

describe('AppShell', () => {
  beforeEach(() => {
    navigationMocks.pathname = '/projects';
  });

  it('renders keyboard-accessible product navigation and marks the current route', () => {
    render(
      <AppShell roles={['EMPLOYEE']}>
        <h1>项目</h1>
      </AppShell>,
    );

    expect(screen.getByRole('navigation', { name: '主导航' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '项目' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: '跳到主要内容' })).toHaveAttribute(
      'href',
      '#main-content',
    );
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main-content');
  });

  it('opens the mobile navigation and closes it with Escape', async () => {
    const user = userEvent.setup();
    render(
      <AppShell roles={['EMPLOYEE']}>
        <h1>项目</h1>
      </AppShell>,
    );

    const menuButton = screen.getByRole('button', { name: '打开导航菜单' });
    await user.click(menuButton);
    expect(screen.getByRole('dialog', { name: '导航菜单' })).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: '导航菜单' })).not.toBeInTheDocument();
    expect(document.activeElement).toBe(menuButton);
  });

  it('keeps the mobile profile link at least 44 by 44 pixels', () => {
    render(
      <AppShell roles={['EMPLOYEE']}>
        <h1>项目</h1>
      </AppShell>,
    );

    const mobileProfileLink = screen
      .getAllByRole('link', { name: '个人资料' })
      .find((link) => link.classList.contains('lg:hidden'));
    expect(mobileProfileLink).toBeDefined();
    expect(mobileProfileLink).toHaveClass('h-11', 'w-11');
    expect(mobileProfileLink).not.toHaveClass('h-10', 'w-10');
  });

  it('uses an AA-compliant contrast level for sidebar group labels', () => {
    render(
      <AppShell roles={['EMPLOYEE']}>
        <h1>项目</h1>
      </AppShell>,
    );

    const workspaceLabel = screen.getByText('工作区');
    expect(workspaceLabel).toHaveClass('text-white/55');
    expect(workspaceLabel).not.toHaveClass('text-white/45');
  });

  it('shows administration only for roles that need it', () => {
    const { rerender } = render(
      <AppShell roles={['EMPLOYEE']}>
        <h1>项目</h1>
      </AppShell>,
    );

    expect(screen.queryByRole('link', { name: '用户管理' })).not.toBeInTheDocument();

    rerender(
      <AppShell roles={['ADMIN']}>
        <h1>项目</h1>
      </AppShell>,
    );
    expect(screen.getByRole('link', { name: '用户管理' })).toBeInTheDocument();
  });
});
