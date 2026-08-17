import 'reflect-metadata';

import assert from 'node:assert/strict';

import { NestFactory } from '@nestjs/core';
import request from 'supertest';

import { AppModule } from '../src/app.module';

async function verifyRuntime(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: false });
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
