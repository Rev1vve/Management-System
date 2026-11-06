import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Vite/Vitest 默认把 SSR 缓存放在系统临时目录；在受限令牌的 CI/沙箱里该目录
  // 可能不允许新建子目录（EPERM），表现为"所有测试文件加载失败"。
  // 固定到仓库内可写目录，让本机与 CI 行为一致。
  cacheDir: 'node_modules/.vite-test-api',
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
  },
});
