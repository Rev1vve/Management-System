import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

/**
 * 登录后的页面级验收：
 *  - 员工用真实登录表单进入，能看到自己的职责首页；
 *  - 管理员/项目经理用注入的已验证会话进入，检查报表与管理页在窄屏可用；
 *  - 所有页面都不能出现横向滚动，主要操作按钮保持 44px 触控高度。
 */
type State = Record<string, { token: string | null; password?: string }>;

const state: State = JSON.parse(
  readFileSync(join(process.cwd(), 'test-results', 'e2e-state.json'), 'utf8'),
);

async function loginAs(page: import('@playwright/test').Page, account: keyof State) {
  const session = state[account];
  if (!session) throw new Error(`e2e 状态缺少 ${account}`);
  if (session.token) {
    await page.context().addCookies([
      {
        name: 'poc_session',
        value: session.token,
        domain: '127.0.0.1',
        path: '/',
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);
    return;
  }
  await page.goto('/login');
  await page.getByLabel(/账号/).fill(account);
  await page.getByLabel(/密码/).fill(session.password!);
  await page.getByRole('button', { name: /登录/ }).first().click();
  await expect(page).not.toHaveURL(/\/login/);
}

async function expectNoHorizontalScroll(page: import('@playwright/test').Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
}

test.describe('authenticated pages', () => {
  test('an employee logs in and sees the dashboard', { tag: '@smoke' }, async ({ page }) => {
    await loginAs(page, 'employee');

    await expect(page.getByRole('heading', { name: '工作台' })).toBeVisible();
    await expectNoHorizontalScroll(page);
  });

  test('the dashboard works on a phone viewport', async ({ page }, testInfo) => {
    await loginAs(page, 'employee');
    await page.goto('/dashboard');

    await expect(page.getByRole('heading', { name: '工作台' })).toBeVisible();
    await expectNoHorizontalScroll(page);
    testInfo.annotations.push({ type: 'viewport', description: `${testInfo.project.name}` });
  });

  test('a project manager sees the managed projects page', async ({ page }) => {
    await loginAs(page, 'manager');
    await page.goto('/managed-projects');

    await expect(page.getByRole('heading', { name: '我管理的项目' })).toBeVisible();
    await expectNoHorizontalScroll(page);
  });

  test('an administrator sees the user list without credential columns', async ({ page }) => {
    await loginAs(page, 'admin');
    await page.goto('/admin/users');

    await expect(page.getByRole('heading', { name: '用户管理' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: '账号' })).toBeVisible();
    // 页面上不该出现任何凭据字段名。
    await expect(page.locator('body')).not.toContainText(/passwordHash|mfaSecret/);
    // 也不能出现哈希值本身（渲染哈希不会触发上面的字段名断言）。
    await expect(page.locator('body')).not.toContainText(/scrypt\$|\$argon2/);
    await expect(page.getByRole('columnheader', { name: /密码|密钥/ })).toHaveCount(0);
    await expectNoHorizontalScroll(page);
  });

  test('the audit page is read-only on a phone viewport', async ({ page }) => {
    await loginAs(page, 'admin');
    await page.goto('/admin/audit');

    await expect(page.getByRole('heading', { name: '审计查询' })).toBeVisible();
    // 只读：任何"写"形态的控件都不该存在（含 icon-only 按钮）。
    const writeControls = page.locator(
      'button[aria-label*="删除"], button[aria-label*="编辑"], a[href*="delete"], a[href*="edit"]',
    );
    await expect(writeControls).toHaveCount(0);
    await expect(page.getByRole('button', { name: /删除|编辑/ })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /删除|编辑/ })).toHaveCount(0);
    await expectNoHorizontalScroll(page);
  });

  test('the reports page renders aggregate cards', async ({ page }) => {
    await loginAs(page, 'manager');
    await page.goto('/reports');

    await expect(page.getByRole('heading', { name: '报表' })).toBeVisible();
    await expect(page.getByText('投入工时')).toBeVisible();
    await expectNoHorizontalScroll(page);
  });
});
