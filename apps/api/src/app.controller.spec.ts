import { describe, expect, it, vi } from 'vitest';

import { AppController } from './app.controller';
import { AppService } from './app.service';

function createService(queryRaw: () => Promise<unknown>) {
  const prisma = { $queryRaw: vi.fn(queryRaw) };
  return { service: new AppService(prisma as never), prisma };
}

describe('AppController', () => {
  it('returns a stable API service status', () => {
    const { service } = createService(async () => [{ '?column?': 1 }]);

    expect(new AppController(service).getRoot()).toEqual({
      service: 'project-operations-api',
      status: 'ok',
    });
  });

  it('reports a healthy database without a session', async () => {
    const { service, prisma } = createService(async () => [{ '?column?': 1 }]);
    const res = { status: vi.fn() };

    const health = await new AppController(service).getHealth(res as never);

    expect(health).toEqual({
      service: 'project-operations-api',
      status: 'ok',
      database: 'up',
    });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('fails closed with 503 when the database is unreachable', async () => {
    const { service } = createService(async () => {
      throw new Error('connection refused');
    });
    const res = { status: vi.fn() };

    const health = await new AppController(service).getHealth(res as never);

    expect(health.status).toBe('degraded');
    expect(health.database).toBe('down');
    expect(res.status).toHaveBeenCalledWith(503);
  });
});
