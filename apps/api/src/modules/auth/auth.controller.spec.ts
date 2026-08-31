import { HEADERS_METADATA } from '@nestjs/common/constants';
import type { Request } from 'express';
import { describe, expect, it, vi } from 'vitest';

import { AuthController } from './auth.controller';

const PUBLIC_ME_FIELDS = ['account', 'id', 'mfaEnabled', 'name', 'status', 'workEmail'].sort();

function expectNoStore(handler: (...args: never[]) => unknown): void {
  expect(Reflect.getMetadata(HEADERS_METADATA, handler)).toEqual(
    expect.arrayContaining([{ name: 'Cache-Control', value: 'no-store' }]),
  );
}

describe('AuthController', () => {
  it('/auth/me returns exactly the public user field whitelist', async () => {
    const controller = new AuthController({} as never, {} as never);
    const request = {
      user: {
        id: 'user-1',
        account: 'alice',
        name: 'Alice',
        workEmail: 'alice@example.test',
        status: 'ACTIVE',
        mfaEnabled: true,
        passwordHash: 'redacted',
        mfaSecretCiphertext: 'redacted',
        failedLoginCount: 3,
        lockedUntil: new Date('2026-08-22T00:00:00.000Z'),
        mfaFailedAttempts: 2,
        mfaLockedUntil: new Date('2026-08-22T00:00:00.000Z'),
        deletedAt: new Date('2026-08-22T00:00:00.000Z'),
      },
    } as unknown as Request;

    const result = await controller.me(request);

    expect(Object.keys(result).sort()).toEqual(PUBLIC_ME_FIELDS);
    expect(result.id).toBe('user-1');
    expect(result.account).toBe('alice');
    expect(result.name).toBe('Alice');
    expect(result.workEmail).toBe('alice@example.test');
    expect(result.status).toBe('ACTIVE');
    expect(result.mfaEnabled).toBe(true);
  });

  it('sets the production login session cookie to HttpOnly, Secure and SameSite=Lax', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.resetModules();

    try {
      const { AuthController: ProductionAuthController } = await import('./auth.controller');
      const controller = new ProductionAuthController(
        {
          login: vi.fn().mockResolvedValue({
            token: 'session-token',
            mfaRequired: false,
            mfaSetupRequired: false,
          }),
        } as never,
        {} as never,
      );
      const response = { cookie: vi.fn() };

      await controller.login(
        { accountOrEmail: 'alice', password: '[REDACTED]' },
        response as never,
      );

      expect(response.cookie).toHaveBeenCalledWith(
        'poc_session',
        'session-token',
        expect.objectContaining({
          httpOnly: true,
          sameSite: 'lax',
          secure: true,
          path: '/',
        }),
      );
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it('marks every sensitive authentication response as non-cacheable', () => {
    expectNoStore(AuthController.prototype.me);
    expectNoStore(AuthController.prototype.login);
    expectNoStore(AuthController.prototype.logout);
    expectNoStore(AuthController.prototype.logoutAll);
  });
});
