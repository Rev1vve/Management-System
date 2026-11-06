#!/usr/bin/env node
/**
 * 本机一次性 PostgreSQL（Windows/无 Docker 环境用）。
 *
 * CI 与生产仍走 `infra/compose.dev.yml` 的 postgres:18.6；本脚本只是让
 * Windows 开发者能在本机跑真实数据库集成测试，版本对齐 18.6。
 *
 * 用法：
 *   node infra/scripts/local-postgres.mjs                       # 只启动并保持运行
 *   node infra/scripts/local-postgres.mjs -- <命令> [参数...]     # 启动、执行、停止
 *
 * 数据目录默认 `.hermes/local-pg/data`（已被 .gitignore 忽略），端口默认 55432。
 */
import { spawn } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

function parseArgs(argv) {
  const options = {
    port: Number(process.env.LOCAL_PG_PORT ?? 55432),
    user: process.env.LOCAL_PG_USER ?? 'postgres',
    password: process.env.LOCAL_PG_PASSWORD ?? 'postgres',
    database: process.env.LOCAL_PG_DATABASE ?? 'project_operations_center',
    dataDir: process.env.LOCAL_PG_DATA_DIR ?? join(repoRoot, '.hermes', 'local-pg'),
    command: [],
    prepare: false,
  };
  const separator = argv.indexOf('--');
  const head = separator === -1 ? argv : argv.slice(0, separator);
  if (separator !== -1) options.command = argv.slice(separator + 1);
  for (let index = 0; index < head.length; index += 1) {
    const flag = head[index];
    const value = head[index + 1];
    if (flag === '--port') ((options.port = Number(value)), (index += 1));
    else if (flag === '--database') ((options.database = value), (index += 1));
    else if (flag === '--data-dir') ((options.dataDir = resolve(value)), (index += 1));
    else if (flag === '--prepare') options.prepare = true;
    else if (flag === '--help') {
      console.log(
        '用法: node infra/scripts/local-postgres.mjs [--port 55432] [--database NAME] [--prepare] [-- <命令>...]',
      );
      process.exit(0);
    } else throw new Error(`未知参数: ${flag}`);
  }
  return options;
}

function connectionString(options) {
  return `postgresql://${options.user}:${options.password}@127.0.0.1:${options.port}/${options.database}?schema=public`;
}

function redactedUrl(options) {
  return `postgresql://${options.user}:***@127.0.0.1:${options.port}/${options.database}`;
}

function runCommand(command, env) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command[0], command.slice(1), {
      cwd: repoRoot,
      env,
      stdio: 'inherit',
      // Windows 上 pnpm/prisma 是 .CMD 包装，必须经 shell 解析。
      shell: process.platform === 'win32',
    });
    child.once('error', rejectRun);
    child.once('exit', (code, signal) => {
      if (signal) rejectRun(new Error(`命令被信号终止: ${signal}`));
      else resolveRun(code ?? 1);
    });
  });
}

const options = parseArgs(process.argv.slice(2));
await mkdir(options.dataDir, { recursive: true });

const postgres = new EmbeddedPostgres({
  databaseDir: options.dataDir,
  user: options.user,
  password: options.password,
  port: options.port,
  persistent: true,
  onLog: (message) => {
    if (process.env.LOCAL_PG_VERBOSE === '1') console.error(`[postgres] ${message}`);
  },
  onError: (message) => console.error(`[postgres] ${message}`),
});

const initialized = await access(join(options.dataDir, 'PG_VERSION'))
  .then(() => true)
  .catch(() => false);
if (!initialized) await postgres.initialise();
await postgres.start();
try {
  await postgres.createDatabase(options.database);
} catch (error) {
  const message = String(error?.message ?? error);
  // 已存在即继续；其它失败必须如实抛出，避免延迟成后面 prisma 的莫名报错。
  if (!/already exists|42P04/i.test(message)) {
    await postgres.stop().catch(() => undefined);
    throw new Error(`[local-postgres] 创建数据库失败：${message}`);
  }
}

const url = connectionString(options);
const childEnv = {
  ...process.env,
  DATABASE_URL: url,
  NODE_ENV: process.env.NODE_ENV ?? 'test',
};
// 只打印脱敏后的地址：完整 URL 含口令，不能进终端/CI 日志。
console.log(`[local-postgres] ready: ${redactedUrl(options)}`);

// 任何分支（prepare / 命令 / 常驻）异常都必须停库，否则会遗留后台 postgres 占用端口。
const stopQuietly = async () => {
  await postgres.stop().catch((error) => console.error(`[local-postgres] stop: ${error}`));
};
const stopOnSignal = async () => {
  await stopQuietly();
  process.exit(0);
};
// 任何分支（prepare / 命令 / 常驻）收到 SIGINT/SIGTERM 都要先停库，
// 否则会遗留嵌入式 postgres 占用端口与数据目录。
process.on('SIGINT', stopOnSignal);
process.on('SIGTERM', stopOnSignal);

process.on('uncaughtException', async (error) => {
  console.error(`[local-postgres] uncaught: ${error}`);
  await stopQuietly();
  process.exit(1);
});
process.on('unhandledRejection', async (error) => {
  console.error(`[local-postgres] unhandled: ${error}`);
  await stopQuietly();
  process.exit(1);
});

if (options.prepare) {
  for (const step of [
    ['pnpm', '--filter', '@project-operations/api', 'exec', 'prisma', 'migrate', 'deploy'],
    ['pnpm', '--filter', '@project-operations/api', 'run', 'db:seed'],
  ]) {
    const code = await runCommand(step, childEnv);
    if (code !== 0) {
      await stopQuietly();
      console.error(`[local-postgres] 准备步骤失败: ${step.join(' ')} (exit ${code})`);
      process.exit(code);
    }
  }
}

if (options.command.length === 0) {
  if (options.prepare) {
    // `pnpm db:local`（空命令）语义是"准备完就退出"，不能悄悄常驻。
    await stopQuietly();
    process.exitCode = 0;
  } else {
  }
} else {
  // runCommand 抛错时也要停机（它的 reject 走 unhandledRejection → 上面的 handler）。
  const code = await runCommand(options.command, childEnv).catch(async (error) => {
    console.error(`[local-postgres] 命令启动失败: ${error}`);
    await stopQuietly();
    return 1;
  });
  await stopQuietly();
  process.exitCode = code;
}
