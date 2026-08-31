import { Test } from '@nestjs/testing';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../app.module';
import { PrismaService } from '../database/prisma.service';
import { MfaCipherService } from '../crypto/mfa-cipher.service';

let attachmentsRoot = '';
let previousRoot: string | undefined;

beforeEach(async () => {
  previousRoot = process.env.ATTACHMENTS_ROOT;
  attachmentsRoot = await mkdtemp(join(tmpdir(), 'poc-task7-runtime-'));
  process.env.ATTACHMENTS_ROOT = attachmentsRoot;
});

afterEach(async () => {
  if (previousRoot === undefined) delete process.env.ATTACHMENTS_ROOT;
  else process.env.ATTACHMENTS_ROOT = previousRoot;
  await rm(attachmentsRoot, { recursive: true, force: true });
});

describe('task 7 runtime routes', () => {
  it('registers business and contract-attachment routes behind authentication', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue({ attachment: { findMany: vi.fn().mockResolvedValue([]) } })
      .overrideProvider(MfaCipherService)
      .useValue({ encrypt: vi.fn(), decrypt: vi.fn() })
      .compile();
    const app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();

    try {
      for (const path of [
        '/api/v1/customers',
        '/api/v1/portfolios',
        '/api/v1/projects',
        '/api/v1/projects/project-1/orders',
        '/api/v1/customers/customer-1/contract-attachments',
      ]) {
        const response = await request(app.getHttpServer()).get(path);
        expect(response.status, path).toBe(401);
      }
    } finally {
      await app.close();
    }
  });
});
