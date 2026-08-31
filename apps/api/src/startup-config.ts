import { BadRequestException, ValidationPipe, type INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';

export type ApiHost = '127.0.0.1' | '0.0.0.0';

type AccessCheck = (path: string, mode?: number) => Promise<void>;

export async function assertApiRuntimeDependencies(
  platform = process.platform,
  check: AccessCheck = access,
): Promise<void> {
  if (platform !== 'linux') throw new Error('附件安全清理仅支持 Linux');
  try {
    await check('/usr/bin/mv', constants.X_OK);
  } catch {
    throw new Error('附件安全清理依赖不可用');
  }
}

export function configureApp(app: INestApplication): void {
  app.setGlobalPrefix('api/v1');
  app.use(cookieParser());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
}

export function resolveApiHost(value: string | undefined): ApiHost {
  if (value === undefined || value === '') return '127.0.0.1';
  if (value === '127.0.0.1' || value === '0.0.0.0') return value;
  throw new BadRequestException('API_HOST 只允许 127.0.0.1 或 0.0.0.0');
}
