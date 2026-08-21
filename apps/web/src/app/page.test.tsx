import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import HomePage from './page';

vi.mock('next/navigation', () => ({
  usePathname: () => '/',
}));

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={String(href)} {...props}>
      {children}
    </a>
  ),
}));

describe('HomePage', () => {
  it('renders an honest unavailable state without claiming there are zero items', () => {
    const { container } = render(<HomePage />);

    expect(screen.getByRole('heading', { name: '工作台' })).toBeInTheDocument();
    expect(screen.getByText('暂未开放')).toBeInTheDocument();
    expect(screen.getByText('待办功能暂未开放')).toBeInTheDocument();
    expect(screen.getByText('私网访问')).toBeInTheDocument();
    expect(screen.getByText('Australia/Melbourne')).toBeInTheDocument();
    expect(screen.queryByText('0 项')).not.toBeInTheDocument();
    expect(container).not.toHaveTextContent(/后续任务|任务\s*\d+|API 尚未|完成.*API 后/);
    expect(screen.queryByText(/网站基础骨架已就绪/)).not.toBeInTheDocument();
  });
});
