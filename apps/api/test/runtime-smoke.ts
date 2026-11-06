import 'reflect-metadata';

import assert from 'node:assert/strict';

import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/database/prisma.service';
import { MfaCipherService } from '../src/crypto/mfa-cipher.service';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ATTACHMENTS_ROOT } from '../src/modules/attachments/attachments.service';
import { installWindowsAclAllowlist } from '../src/testing/windows-acl-allowlist';

async function verifyRuntime(): Promise<void> {
  await installWindowsAclAllowlist();
  // Compile the real AppModule but stub the database-backed and key-backed
  // providers: the quality gate has no live PostgreSQL or MFA_SECRET_KEY.
  // The smoke test asserts the module graph compiles and the HTTP runtime
  // answers on the status route; database behaviour is covered by the
  // integration suite against a disposable container.
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaService)
    .useValue({ attachment: { findMany: () => Promise.resolve([]) } })
    .overrideProvider(MfaCipherService)
    .useValue({ encrypt: () => '', decrypt: () => '' })
    .overrideProvider(ATTACHMENTS_ROOT)
    .useValue(join(tmpdir(), 'project-operations-runtime-smoke-attachments'))
    .compile();
  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  await app.init();

  try {
    const response = await request(app.getHttpServer()).get('/api/v1');

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      service: 'project-operations-api',
      status: 'ok',
    });
  } finally {
    await app.close();
  }
}

void verifyRuntime().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
