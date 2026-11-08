import { defineConfig, devices } from '@playwright/test';

/**
 * 任务 12 的浏览器级验收。
 *
 * 依赖两个已在跑的服务（见 `pnpm e2e` 的说明）：
 *  - Web  : http://127.0.0.1:3000（`next dev`，把 /api 反代到 API）
 *  - API  : http://127.0.0.1:3001（NestJS，连本地 PostgreSQL）
 * 不在配置里自动拉起，是因为 API 需要真实数据库与种子数据；把启动脚本留给
 * `package.json` 的 `e2e`，失败时的报错更直白。
 */

function projectsFor(browsers: string[]) {
  const wanted = browsers.map((value) => value.trim()).filter(Boolean);
  const projects = [];
  if (wanted.includes('chromium')) {
    projects.push({ name: 'desktop', use: { ...devices['Desktop Chrome'] } });
    // 手机视口：窄屏可用（44px 触控目标、无横向滚动）是任务 12 的验收项。
    projects.push({ name: 'mobile', use: { ...devices['Pixel 7'] } });
  }
  if (wanted.includes('firefox')) {
    projects.push({ name: 'firefox', use: { ...devices['Desktop Firefox'] } });
  }
  return projects;
}

const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3000';

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  timeout: 30_000,
  expect: { timeout: 7_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  // 默认 Chromium 的桌面 + 手机视口；定时任务用 E2E_BROWSERS=chromium,firefox 扩到 Firefox。
  projects: projectsFor((process.env.E2E_BROWSERS ?? 'chromium').split(',')),
});
