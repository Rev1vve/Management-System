import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { assertApiRuntimeDependencies, configureApp, resolveApiHost } from './startup-config';

async function bootstrap(): Promise<void> {
  await assertApiRuntimeDependencies();
  const app = await NestFactory.create(AppModule);
  configureApp(app);

  const port = Number(process.env.API_PORT ?? 3001);
  await app.listen(port, resolveApiHost(process.env.API_HOST));
}

void bootstrap();
