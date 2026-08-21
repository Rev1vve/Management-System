import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import AdminInvitePage from './page';

describe('AdminInvitePage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    global.fetch = vi.fn();
  });

  it('confirms queued email delivery without rendering a bearer token', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          invitationId: 'invitation-1',
          expiresAt: '2026-09-01T00:00:00.000Z',
          token: 'should-never-render',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const user = userEvent.setup();
    render(<AdminInvitePage />);

    await user.type(screen.getByLabelText('工作邮箱'), 'new-hire@example.test');
    await user.click(screen.getByRole('button', { name: '发送邀请' }));

    expect(await screen.findByRole('status')).toHaveTextContent('激活邮件已加入发送队列');
    expect(screen.queryByText(/should-never-render/)).not.toBeInTheDocument();
    expect(screen.queryByText(/开发环境直接返回令牌/)).not.toBeInTheDocument();
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
  });
});
