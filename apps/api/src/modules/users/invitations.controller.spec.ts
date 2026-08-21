import { describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';

import { InvitationsController } from './invitations.controller';
import type { InvitationsService } from './invitations.service';

describe('InvitationsController', () => {
  it('never returns the raw invitation token to the browser', async () => {
    const expiresAt = new Date('2026-09-01T00:00:00.000Z');
    const createInvitation = vi.fn(async () => ({
      token: 'raw-bearer-token',
      invitation: { id: 'invitation-1', expiresAt },
    }));
    const controller = new InvitationsController({
      createInvitation,
    } as unknown as InvitationsService);
    const request = { user: { id: 'admin-1' } } as unknown as Request;

    const response = await controller.create(request, { email: 'new-hire@example.test' });

    expect(response).toEqual({
      ok: true,
      invitationId: 'invitation-1',
      expiresAt,
    });
    expect(response).not.toHaveProperty('token');
    expect(JSON.stringify(response)).not.toContain('raw-bearer-token');
  });
});
