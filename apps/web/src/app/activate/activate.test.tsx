import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ActivatePage from './page';

const navigationMocks = vi.hoisted(() => ({
  push: vi.fn(),
  token: 'invitation-token-fixture',
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: navigationMocks.push }),
  useSearchParams: () => new URLSearchParams({ token: navigationMocks.token }),
}));

describe('ActivatePage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    navigationMocks.push.mockReset();
    navigationMocks.token = 'invitation-token-fixture';
    global.fetch = vi.fn();
  });

  it('submits the token from the activation link query string', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, account: 'new-hire' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const user = userEvent.setup();
    render(<ActivatePage />);

    await user.type(screen.getByLabelText('姓名'), '新同事');
    await user.type(screen.getByLabelText('密码'), 'correct horse battery staple');
    await user.type(screen.getByLabelText('确认密码'), 'correct horse battery staple');
    await user.click(screen.getByRole('button', { name: '激活并登录' }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/v1/invitations/accept',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            token: 'invitation-token-fixture',
            name: '新同事',
            password: 'correct horse battery staple',
          }),
        }),
      );
    });
    expect(navigationMocks.push).toHaveBeenCalledWith('/?activated=new-hire');
    expect(screen.queryByText('invitation-token-fixture')).not.toBeInTheDocument();
  });
});
