import 'reflect-metadata';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from './app.module';
import { PrismaService } from './database/prisma.service';
import { MfaCipherService } from './crypto/mfa-cipher.service';
import { ATTACHMENTS_ROOT } from './modules/attachments/attachments.service';
import { installWindowsAclAllowlist } from './testing/windows-acl-allowlist';

describe('API root endpoint', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await installWindowsAclAllowlist();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      // This smoke test only exercises the root status endpoint; the
      // database-backed and key-backed providers are replaced with stubs so
      // the module compiles without a live PostgreSQL or MFA_SECRET_KEY.
      .overrideProvider(PrismaService)
      .useValue({ attachment: { findMany: () => Promise.resolve([]) } })
      .overrideProvider(MfaCipherService)
      .useValue({ encrypt: () => '', decrypt: () => '' })
      .overrideProvider(ATTACHMENTS_ROOT)
      .useValue(join(tmpdir(), 'project-operations-test-attachments'))
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('returns the service status through the Nest HTTP runtime', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      service: 'project-operations-api',
      status: 'ok',
    });
  });
});
