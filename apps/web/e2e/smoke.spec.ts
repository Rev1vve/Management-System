import { expect, test } from '@playwright/test';

/**
 * 冒烟：未登录访问受保护页面必须被挡回登录页，登录页在窄屏下不产生横向滚动，
 * 且关键控件达到 44px 触控高度（任务 12 的验收项）。
 */
test.describe('unauthenticated shell', () => {
  test('redirects protected pages to the login page', { tag: '@smoke' }, async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole('heading', { name: /登录|工作区/ }).first()).toBeVisible();
  });

  test(
    'renders the login form without horizontal scrolling',
    { tag: '@smoke' },
    async ({ page }) => {
      await page.goto('/login');
      await expect(page.getByLabel(/账号/)).toBeVisible();
      await expect(page.getByLabel(/密码/)).toBeVisible();

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(1);
    },
  );

  test('keeps the primary submit control at least 44px tall', async ({ page }) => {
    await page.goto('/login');
    const submit = page.getByRole('button', { name: /登录/ }).first();
    await expect(submit).toBeVisible();
    const box = await submit.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  });
});
