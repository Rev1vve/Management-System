import { constants, type Stats } from 'node:fs';
import { type FileHandle, lstat, open, realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join, resolve } from 'node:path';
import { BadRequestException } from '@nestjs/common';

/**
 * 附件存储对文件系统安全语义的最小抽象。
 *
 * Linux（生产/CI 唯一交付基线）——与任务 7 审查收敛的实现逐条等价：
 * 0700/0600 + 运行用户所有权 + `/proc/self/fd` 句柄锚定 + `O_NOFOLLOW` + `mv -nT`。
 *
 * Windows（仅本机开发/验收）——用可得原语提供**可验证的等价目标**：
 * - 私有性：**白名单**校验。目录/文件 ACL 中每一条 `Allow` 的主体必须是
 *   {运行账号 SID, SYSTEM, Administrators, 运维显式扩展白名单} 之一；其余一律拒绝（fail closed）。
 *   已知宽泛主体（Everyone / Users / Authenticated Users / INTERACTIVE / ANONYMOUS / Guests）
 *   无条件拒绝，即使被写进扩展白名单也不放行。`Deny` 条目只收紧权限，忽略。
 *   注意：Windows 上**不主动改写 ACL**（改写会破坏运维既有授权，且在受限令牌环境下会把服务自己锁死），
 *   只做校验并如实上报；root 的 ACL 由部署时准备（README 有说明）。
 * - 句柄锚定：Windows 不允许 `fs.open` 打开目录，改用"每级 lstat + realpath 归一 + dev/ino 复核"，
 *   TOCTOU 面由"root 位于私有位置 + ACL 白名单"承担，弱于 `/proc/self/fd`（如实记录，不粉饰）。
 * - 无覆盖移动：`link()`（目标存在即 EEXIST）+ `unlink()`，与 `mv -nT` 的"绝不覆盖"语义等价。
 * - 目录 fsync：Windows 无等价原语，降级为 no-op（NTFS 元数据日志承担持久性）。
 *
 * 其它平台（darwin/BSD 等）：不支持，涉及锚定/移动的操作直接失败关闭（与任务 7 的显式拒绝一致）。
 */

export type StoragePlatform = 'linux' | 'win32' | 'unsupported';

export const STORAGE_PLATFORM: StoragePlatform =
  process.platform === 'linux' ? 'linux' : process.platform === 'win32' ? 'win32' : 'unsupported';

export function requireAnchoredStorage(): void {
  if (STORAGE_PLATFORM === 'unsupported') {
    throw new BadRequestException('附件安全存储仅支持 Linux 与 Windows');
  }
}

/** 目录锚点：Linux 持有目录句柄（fd），Windows 持有已校验路径。 */
export interface DirectoryAnchor {
  readonly fd: number | undefined;
  child(name: string): string;
  stat(): Promise<Stats>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

class PosixDirectoryAnchor implements DirectoryAnchor {
  constructor(
    private readonly handle: FileHandle,
    readonly fd: number,
  ) {}

  child(name: string): string {
    return join('/proc/self/fd', String(this.fd), name);
  }

  stat(): Promise<Stats> {
    return this.handle.stat();
  }

  sync(): Promise<void> {
    return this.handle.sync();
  }

  close(): Promise<void> {
    return this.handle.close();
  }
}

class WindowsDirectoryAnchor implements DirectoryAnchor {
  readonly fd = undefined;

  constructor(
    readonly path: string,
    private readonly identity: { dev: number; ino: number },
  ) {}

  child(name: string): string {
    return join(this.path, name);
  }

  async stat(): Promise<Stats> {
    const info = await lstat(this.path);
    if (info.dev !== this.identity.dev || info.ino !== this.identity.ino) {
      throw new BadRequestException('附件目录必须是私有实体目录');
    }
    return info;
  }

  sync(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

/** 目录/文件元数据校验（不含 ACL）。 */
export function assertPrivateDirectory(info: Stats): void {
  if (STORAGE_PLATFORM === 'linux') {
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    if (
      uid === undefined ||
      gid === undefined ||
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== uid ||
      info.gid !== gid ||
      (info.mode & 0o777) !== 0o700
    ) {
      throw new BadRequestException('附件目录必须由运行用户拥有且权限为 0700');
    }
    return;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new BadRequestException('附件目录必须是私有实体目录');
  }
}

export function assertPrivateFile(info: Stats): void {
  if (STORAGE_PLATFORM === 'linux') {
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    if (
      uid === undefined ||
      gid === undefined ||
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.uid !== uid ||
      info.gid !== gid ||
      (info.mode & 0o7777) !== 0o600
    ) {
      throw new BadRequestException('附件文件必须由运行用户拥有且权限为 0600');
    }
    return;
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new BadRequestException('附件文件必须是私有实体文件');
  }
}

function samePath(left: string, right: string): boolean {
  // Linux 保持严格相等（与任务 7 的 `canonical !== directory` 一致）；
  // Windows 需要大小写折叠与分隔符归一。
  if (STORAGE_PLATFORM !== 'win32') return left === right;
  return resolve(left).toLowerCase() === resolve(right).toLowerCase();
}

/** 目录私有性完整校验：元数据 + 归一化路径 + （Windows）ACL 白名单。 */
export async function assertPrivateDirectoryPath(directory: string): Promise<Stats> {
  requireAnchoredStorage();
  const info = await lstat(directory);
  assertPrivateDirectory(info);
  const canonical = await realpath(directory).catch(() => null);
  if (canonical === null || !samePath(canonical, directory)) {
    throw new BadRequestException('附件目录必须是私有实体目录');
  }
  if (STORAGE_PLATFORM === 'win32') await assertPrivateAcl(directory);
  return info;
}

/** 打开私有目录锚点。 */
export async function openPrivateDirectory(directory: string): Promise<DirectoryAnchor> {
  requireAnchoredStorage();
  if (STORAGE_PLATFORM === 'linux') {
    // 必须用 constants：O_DIRECTORY/O_NOFOLLOW 的取值随架构不同（x86_64 与 arm64 不同），
    // 硬编码八进制会在 ARM Linux 上直接 EINVAL。
    const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
    const handle = await open(directory, flags);
    try {
      const opened = await handle.stat();
      assertPrivateDirectory(opened);
      return new PosixDirectoryAnchor(handle, handle.fd);
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }
  const info = await assertPrivateDirectoryPath(directory);
  return new WindowsDirectoryAnchor(directory, { dev: info.dev, ino: info.ino });
}

/** 上传临时文件的独占创建标志（Linux O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW；Windows 'wx'）。 */
export function uploadTempOpenFlags(): number | string {
  requireAnchoredStorage();
  if (STORAGE_PLATFORM === 'linux') {
    return constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
  }
  return 'wx';
}

/** 只读打开已校验文件；Windows 无 O_NOFOLLOW，改由前置 lstat + 打开后身份复核承担。 */
export async function openPrivateFileRead(path: string): Promise<FileHandle | null> {
  requireAnchoredStorage();
  if (STORAGE_PLATFORM === 'linux') {
    return open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
  }
  return open(path, 'r').catch(() => null);
}

/**
 * 无条件拒绝的宽泛主体 SID（即使写进扩展白名单也不放行）：
 * Everyone / INTERACTIVE / ANONYMOUS / Authenticated Users / Users / Guests。
 */
export const WIDE_ACCESS_SIDS = new Set([
  'S-1-1-0', // Everyone
  'S-1-3-0', // CREATOR OWNER
  'S-1-5-4', // INTERACTIVE
  'S-1-5-7', // ANONYMOUS LOGON
  'S-1-5-11', // Authenticated Users
  'S-1-5-32-545', // BUILTIN\Users
  'S-1-5-32-546', // BUILTIN\Guests
  'S-1-5-32-555', // Remote Desktop Users
  'S-1-5-32-562', // Distributed COM Users
]);

/** 与 SYSTEM / Administrators 等价的可信主体 SID。 */
export const TRUSTED_ACL_SIDS = new Set(['S-1-5-18', 'S-1-5-32-544']);

export interface AclEntry {
  sid: string;
  type: 'allow' | 'deny';
  rights: string;
}

const POWERSHELL = join(
  process.env.SystemRoot ?? 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
);

const ACL_PROBE_PATH_ENV = 'ATTACHMENTS_ACL_PROBE_PATH';

/**
 * 解析 ACL 查询输出（每行 `SID|Allow|Rights`）。
 * 纯函数；解析不出任何合法条目时返回空数组，由调用方 fail closed。
 */
export function parseAclOutput(output: string): AclEntry[] {
  const entries: AclEntry[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const parts = line.split('|');
    if (parts.length < 3) continue;
    const sid = parts[0]!.trim();
    const type = parts[1]!.trim().toLowerCase();
    const rights = parts.slice(2).join('|').trim();
    if (!/^S-\d-\d+(-\d+)+$/i.test(sid)) continue;
    if (type !== 'allow' && type !== 'deny') continue;
    entries.push({ sid: sid.toUpperCase(), type, rights });
  }
  return entries;
}

/**
 * ACL 白名单判定（纯函数，单测覆盖）。
 *
 * 1. 宽泛主体出现 Allow → 拒绝；
 * 2. 任何 Allow 主体不在 {运行账号, SYSTEM, Administrators, 扩展白名单} → 拒绝；
 * 3. Deny 条目忽略（只会收紧）；
 * 4. 运行账号必须持有 FullControl 或 Modify；
 * 5. 没有任何 Allow → 拒绝（fail closed）。
 */
export function evaluateAcl(
  entries: AclEntry[],
  runtimeSid: string,
  extraAllowedSids: Iterable<string> = [],
): { ok: true } | { ok: false; reason: string } {
  const runtime = runtimeSid.toUpperCase();
  const allowed = new Set<string>([runtime, ...TRUSTED_ACL_SIDS]);
  for (const raw of extraAllowedSids) {
    const sid = raw.trim().toUpperCase();
    if (sid.length === 0 || WIDE_ACCESS_SIDS.has(sid)) continue;
    allowed.add(sid);
  }

  const allows = entries
    .filter((entry) => entry.type === 'allow')
    .map((entry) => ({ ...entry, sid: entry.sid.toUpperCase() }));
  if (allows.length === 0) return { ok: false, reason: '附件目录 ACL 为空' };

  let runtimeFullControl = false;
  for (const entry of allows) {
    if (WIDE_ACCESS_SIDS.has(entry.sid)) {
      return { ok: false, reason: `附件目录 ACL 向宽泛主体开放：${entry.sid}` };
    }
    if (!allowed.has(entry.sid)) {
      return { ok: false, reason: `附件目录 ACL 向非授权主体开放：${entry.sid}` };
    }
    if (entry.sid === runtime && /FullControl|Modify/i.test(entry.rights)) {
      runtimeFullControl = true;
    }
  }
  if (!runtimeFullControl) return { ok: false, reason: '附件目录 ACL 未授予运行账号完全控制' };
  return { ok: true };
}

/** 扩展白名单来源（默认空；受限令牌/CI 沙箱才显式配置）。 */
export function aclExtraAllowedSids(): string | undefined {
  return process.env.ATTACHMENTS_ACL_ALLOWED_SIDS;
}

function parseExtraAllowedSids(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

let currentSidPromise: Promise<string> | null = null;

/** 当前进程令牌的用户 SID（使用绝对路径 PowerShell，不依赖 PATH）。 */
export function currentUserSid(): Promise<string> {
  if (currentSidPromise) return currentSidPromise;
  currentSidPromise = runPowerShell(
    '[Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
  ).then((output) => {
    const sid = output.trim();
    if (!/^S-\d-\d+(-\d+)+$/i.test(sid)) {
      throw new BadRequestException('附件目录私有性校验失败：无法确定运行账号 SID');
    }
    return sid.toUpperCase();
  });
  return currentSidPromise;
}

/** 供测试重置身份缓存。 */
export function resetIdentityCache(): void {
  currentSidPromise = null;
}

/** 读取目录/文件 ACL（结构化 SID 形式，不受系统语言与代码页影响）。 */
export async function readAclEntries(path: string): Promise<AclEntry[]> {
  const script =
    `(Get-Acl -LiteralPath $env:${ACL_PROBE_PATH_ENV}).Access | ForEach-Object { ` +
    `$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value + '|' + ` +
    `$_.AccessControlType + '|' + $_.FileSystemRights }`;
  const output = await runPowerShell(script, { [ACL_PROBE_PATH_ENV]: path });
  return parseAclOutput(output);
}

/** Windows：校验目录 ACL 通过白名单判定。 */
export async function assertPrivateAcl(directory: string): Promise<void> {
  if (STORAGE_PLATFORM !== 'win32') return;
  const runtimeSid = await currentUserSid();
  const entries = await readAclEntries(directory);
  const verdict = evaluateAcl(entries, runtimeSid, parseExtraAllowedSids(aclExtraAllowedSids()));
  if (!verdict.ok) throw new BadRequestException('附件目录 ACL 未收紧');
}

/** 仅校验 ACL（调用方已持有自己的 lstat 结果时使用，避免重复 stat）。 */
export async function assertPrivateAclOnly(path: string): Promise<void> {
  if (STORAGE_PLATFORM !== 'win32') return;
  await assertPrivateAcl(path);
}

function runPowerShell(script: string, env?: Record<string, string>): Promise<string> {
  return new Promise((resolveExec, rejectExec) => {
    execFile(
      POWERSHELL,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, env: env ? { ...process.env, ...env } : process.env },
      (error, stdout, stderr) => {
        if (error) {
          const detail = (stderr || error.message).trim().slice(0, 200);
          rejectExec(
            new BadRequestException(`附件目录私有性校验失败：ACL 查询工具不可用（${detail}）`),
          );
          return;
        }
        resolveExec(stdout);
      },
    );
  });
}
