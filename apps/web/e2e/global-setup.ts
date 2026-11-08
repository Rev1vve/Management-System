import { PrismaPg } from '@prisma/adapter-pg';
import { createHash, randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { PrismaClient } from '../../api/src/generated/prisma/client';

/**
 * Playwright 全局准备：让 e2e 能"以某个身份"进入系统。
 *
 * 这些写入只允许发生在**本机测试库**上，因此有三道护栏：
 *  1. 必须显式设置 `E2E_ALLOW_DB_WRITES=true`（CI/本地运行 e2e 时由脚本传入）；
 *  2. 拒绝 NODE_ENV=production；
 *  3. 只接受 localhost/127.0.0.1 的数据库地址。
 * 凭据每轮随机生成，写进 apps/web/test-results（已 gitignore、权限 0600），
 * 并在 global-teardown 里吊销会话、清掉演示账号的密码。
 */
// Playwright 以 CommonJS 加载 globalSetup/Teardown：用 __dirname，避免 import.meta 报错。
const STATE_DIR = join(__dirname, '..', 'test-results');
const STATE_PATH = join(STATE_DIR, 'e2e-state.json');

/** 与 api 的 PasswordHashService 完全同格式：scrypt$N$r$p$saltB64url$keyB64url。 */
async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(24);
  const key = await new Promise<Buffer>((resolve, reject) => {
    scryptCallback(
      password,
      salt,
      64,
      { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 },
      (error, derived) => {
        if (error) reject(error);
        else resolve(derived as Buffer);
      },
    );
  });
  return ['scrypt', 32768, 8, 1, salt.toString('base64url'), key.toString('base64url')].join('$');
}

function assertLocalTestDatabase(connectionString: string): void {
  if (process.env.E2E_ALLOW_DB_WRITES !== 'true') {
    throw new Error('e2e 会改写测试库账号，请显式设置 E2E_ALLOW_DB_WRITES=true');
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('拒绝在 production 环境运行 e2e 准备脚本');
  }
  const host = new URL(connectionString).hostname;
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new Error(`e2e 只允许本机数据库，当前是 ${host}`);
  }
}

export default async function globalSetup(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('e2e 需要 DATABASE_URL（指向本地测试库）');
  assertLocalTestDatabase(connectionString);

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

  try {
    const password = `E2e-${randomBytes(12).toString('base64url')}`;
    const passwordHash = await hashPassword(password);
    const state: Record<string, { token: string | null; password?: string }> = {};

    for (const account of ['employee', 'manager', 'admin'] as const) {
      const user = await prisma.user.findUnique({ where: { account } });
      if (!user) throw new Error(`缺少演示账号 ${account}，请先运行 pnpm db:local`);

      // 清掉上一轮遗留的 e2e 会话，避免越积越多。
      await prisma.session.deleteMany({
        where: { userId: user.id, deviceInfo: 'playwright-e2e' },
      });

      if (account === 'employee') {
        await prisma.user.update({
          where: { id: user.id },
          data: { passwordHash, mfaEnabled: false },
        });
        state[account] = { token: null, password };
        continue;
      }

      // 特权账号要求 TOTP，UI 登录需要动态码：这里只注入会话，供页面级验收使用，
      // 会话标记 deviceInfo 以便 teardown 精确吊销。
      const token = randomBytes(32).toString('hex');
      await prisma.session.create({
        data: {
          userId: user.id,
          tokenHash: createHash('sha256').update(token).digest('hex'),
          status: 'ACTIVE',
          deviceInfo: 'playwright-e2e',
          expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        },
      });
      state[account] = { token };
    }

    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
  } finally {
    await prisma.$disconnect();
  }
}
