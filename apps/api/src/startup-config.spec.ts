import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { assertApiRuntimeDependencies, configureApp, resolveApiHost } from './startup-config';

describe('resolveApiHost', () => {
  it('defaults to loopback when API_HOST is unset', () => {
    expect(resolveApiHost(undefined)).toBe('127.0.0.1');
  });

  it('allows an explicit all-interface container bind', () => {
    expect(resolveApiHost('0.0.0.0')).toBe('0.0.0.0');
  });

  it('fails closed for every other host', () => {
    expect(() => resolveApiHost('localhost')).toThrow(BadRequestException);
  });
});

describe('configureApp', () => {
  it('applies the production prefix, cookie middleware and fail-closed validation pipe', () => {
    const app = {
      setGlobalPrefix: vi.fn(),
      use: vi.fn(),
      useGlobalPipes: vi.fn(),
    };

    configureApp(app as never);

    expect(app.setGlobalPrefix).toHaveBeenCalledWith('api/v1');
    expect(app.use).toHaveBeenCalledTimes(1);
    expect(app.useGlobalPipes).toHaveBeenCalledWith(
      expect.objectContaining({
        isTransformEnabled: true,
        validatorOptions: expect.objectContaining({ whitelist: true, forbidNonWhitelisted: true }),
      }),
    );
  });
});

describe('assertApiRuntimeDependencies', () => {
  it('requires an executable fixed-path no-clobber mover on Linux', async () => {
    const check = vi.fn().mockResolvedValue(undefined);

    await expect(assertApiRuntimeDependencies('linux', check)).resolves.toBeUndefined();

    expect(check).toHaveBeenCalledWith('/usr/bin/mv', expect.any(Number));
  });

  it('accepts Windows (link/unlink path) without requiring the GNU mover', async () => {
    const check = vi.fn();

    await expect(assertApiRuntimeDependencies('win32', check)).resolves.toBeUndefined();
    expect(check).not.toHaveBeenCalled();
  });

  it('fails closed on unsupported platforms or a missing mover', async () => {
    await expect(assertApiRuntimeDependencies('darwin', vi.fn())).rejects.toThrow(
      '附件安全存储仅支持 Linux 与 Windows',
    );
    await expect(
      assertApiRuntimeDependencies('linux', vi.fn().mockRejectedValue(new Error('missing'))),
    ).rejects.toThrow('附件安全清理依赖不可用');
  });
});
