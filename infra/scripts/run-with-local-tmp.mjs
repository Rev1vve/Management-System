#!/usr/bin/env node
/**
 * 在仓库内的固定临时目录下运行命令。
 *
 * 为什么需要：Vite/Vitest 会在系统临时目录里 `mkdtemp(...)/ssr` 存放 SSR 模块。
 * 受限令牌的 CI/沙箱（以及部分加固过的 Windows 主机）会让该目录在运行中途变成不可写，
 * 表现为"所有测试文件加载失败 + EPERM: mkdir ...\\ssr"，且与测试代码无关。
 * 把 TMP/TEMP/TMPDIR 指到仓库内可写目录后，本机与 CI 行为一致，也不会污染系统临时目录。
 *
 * 用法：node infra/scripts/run-with-local-tmp.mjs <命令> [参数...]
 */
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.argv.length < 3) {
  console.error('用法: node infra/scripts/run-with-local-tmp.mjs <命令> [参数...]');
  process.exit(2);
}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
// 放在仓库内固定目录：受限令牌的沙箱/加固主机可能禁止在系统临时目录下新建目录，
// 但允许在仓库工作区写入，这样 turbo 与直接运行的行为一致。
const tempDir = process.env.POC_TEST_TMP ?? join(repoRoot, 'node_modules', '.tmp-runs');
await mkdir(tempDir, { recursive: true });

const [command, ...args] = process.argv.slice(2);
const child = spawn(command, args, {
  cwd: process.cwd(),
  stdio: 'inherit',
  // Windows 上 pnpm/prisma 是 .CMD 包装，必须经 shell 解析。
  shell: process.platform === 'win32',
  env: {
    ...process.env,
    TMP: tempDir,
    TEMP: tempDir,
    TMPDIR: tempDir,
  },
});

child.once('error', (error) => {
  console.error(`[run-with-local-tmp] 启动失败: ${error.message}`);
  process.exit(1);
});
child.once('exit', (code, signal) => {
  if (signal) process.exit(1);
  process.exit(code ?? 1);
});
