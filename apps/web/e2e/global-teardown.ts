import { PrismaPg } from '@prisma/adapter-pg';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { PrismaClient } from '../../api/src/generated/prisma/client';

/**
 * e2e 收尾：吊销准备脚本铸造的会话，并把演示账号恢复成"没有密码"的状态，
 * 避免静态已知凭据长期留在测试库里。
 */
// Playwright 以 CommonJS 加载 globalSetup/Teardown：用 __dirname，避免 import.meta 报错。
const STATE_DIR = join(__dirname, '..', 'test-results');
const STATE_PATH = join(STATE_DIR, 'e2e-state.json');

export default async function globalTeardown(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return;

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  try {
    await prisma.session.deleteMany({ where: { deviceInfo: 'playwright-e2e' } });
    await prisma.user.updateMany({
      where: { account: 'employee' },
      data: { passwordHash: null },
    });
  } finally {
    await prisma.$disconnect();
    if (existsSync(STATE_PATH)) rmSync(STATE_PATH, { force: true });
  }
}
