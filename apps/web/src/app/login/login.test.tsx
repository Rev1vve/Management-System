import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import LoginPage from './page';

const routerMocks = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => routerMocks,
}));

describe('LoginPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    routerMocks.push.mockReset();
    routerMocks.replace.mockReset();
    global.fetch = vi.fn();
  });

  it('renders the login form with account and password fields', () => {
    render(<LoginPage />);
    expect(screen.getByLabelText(/账号或工作邮箱/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/密码/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /登录/i })).toBeInTheDocument();
  });

  it('shows validation errors for empty required fields', async () => {
    const user = userEvent.setup();
    render(<LoginPage />);
    await user.click(screen.getByRole('button', { name: /登录/i }));
    expect(await screen.findByText(/请输入账号或工作邮箱/i)).toBeInTheDocument();
    expect(screen.getByText(/请输入密码/i)).toBeInTheDocument();
  });

  it('posts credentials and navigates to the app on success', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ mfaRequired: false, mfaSetupRequired: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const user = userEvent.setup();
    render(<LoginPage />);
    await user.type(screen.getByLabelText(/账号或工作邮箱/i), 'admin');
    await user.type(screen.getByLabelText(/密码/i), 'correct horse battery staple');
    await user.click(screen.getByRole('button', { name: /登录/i }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/v1/auth/login',
        expect.objectContaining({
          method: 'POST',
          // api.ts builds a real Headers instance carrying the CSRF header;
          // instance internals are not enumerable, so assert the object shape.
          headers: expect.any(Headers),
        }),
      );
    });
    await waitFor(() => expect(routerMocks.push).toHaveBeenCalledWith('/'));
  });

  it('shows the API error message on failed login', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ message: '账号或密码错误' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const user = userEvent.setup();
    render(<LoginPage />);
    await user.type(screen.getByLabelText(/账号或工作邮箱/i), 'admin');
    await user.type(screen.getByLabelText(/密码/i), 'wrong password here');
    await user.click(screen.getByRole('button', { name: /登录/i }));

    expect(await screen.findByText(/账号或密码错误/i)).toBeInTheDocument();
  });

  it('routes to MFA verification when MFA is required', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ mfaRequired: true, mfaSetupRequired: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const user = userEvent.setup();
    render(<LoginPage />);
    await user.type(screen.getByLabelText(/账号或工作邮箱/i), 'admin');
    await user.type(screen.getByLabelText(/密码/i), 'correct horse battery staple');
    await user.click(screen.getByRole('button', { name: /登录/i }));

    await waitFor(() => expect(routerMocks.push).toHaveBeenCalledWith('/mfa'));
  });

  it('routes to MFA setup when a privileged role requires enrollment', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ mfaRequired: true, mfaSetupRequired: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const user = userEvent.setup();
    render(<LoginPage />);
    await user.type(screen.getByLabelText(/账号或工作邮箱/i), 'admin');
    await user.type(screen.getByLabelText(/密码/i), 'correct horse battery staple');
    await user.click(screen.getByRole('button', { name: /登录/i }));

    await waitFor(() => expect(routerMocks.push).toHaveBeenCalledWith('/mfa-setup'));
  });
});
