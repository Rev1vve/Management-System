#!/usr/bin/env node
/**
 * 跨平台运行 infra 契约测试。
 *
 * CI（ubuntu）使用 `python3`；Windows 本机通常只有 `python` 或 `py`。
 * 这里按顺序探测解释器，避免把"命令名不存在"误当成契约失败。
 */
import { spawnSync } from 'node:child_process';

const candidates = [process.env.PYTHON, 'python3', 'python', 'py'].filter(
  (value) => typeof value === 'string' && value.length > 0,
);

const args = ['-m', 'unittest', 'discover', '-s', 'infra/tests', '-p', 'test_*.py', '-v'];

let lastError = null;
for (const candidate of candidates) {
  const probe = spawnSync(candidate, ['--version'], { stdio: 'ignore', shell: false });
  // Windows 的应用商店 python.exe 存根会以非零码退出（9009），必须继续探测下一个。
  if (probe.error || probe.status !== 0) {
    lastError = probe.error ?? new Error(candidate + ' exited ' + probe.status);
    continue;
  }
  const run = spawnSync(candidate, args, { stdio: 'inherit', shell: false });
  if (run.error) {
    lastError = run.error;
    continue;
  }
  process.exit(run.status ?? 1);
}

console.error('[infra:check] 未找到可用的 Python 解释器:', lastError?.message ?? 'unknown');
process.exit(1);
