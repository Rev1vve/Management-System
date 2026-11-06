import { tmpdir } from 'node:os';

import {
  readAclEntries,
  TRUSTED_ACL_SIDS,
  WIDE_ACCESS_SIDS,
} from '../modules/attachments/storage-platform';

/**
 * 仅测试用：把本机临时目录上"已经存在"的额外 ACL 主体加入白名单。
 *
 * 为什么需要：受限令牌（CI 沙箱）与部分开发机在 `%TEMP%` 上带有额外的受限主体，
 * 生产默认白名单（运行账号 + SYSTEM + Administrators）会按设计拒绝这些目录，
 * 导致测试无法在不"放宽平台策略"的前提下运行。
 *
 * 这里做的是**测试进程级**、显式、可见的配置：只在 Windows 且未显式配置时生效，
 * 且永远不会把宽泛主体（Everyone/Users/...)加入白名单——平台层会无条件拒绝它们，
 * 由 `storage-platform.spec.ts` 的纯函数用例固定该语义。
 */
export async function installWindowsAclAllowlist(): Promise<void> {
  if (process.platform !== 'win32' || process.env.ATTACHMENTS_ACL_ALLOWED_SIDS) return;
  const entries = await readAclEntries(tmpdir());
  const extra = entries
    .filter((entry) => entry.type === 'allow')
    .map((entry) => entry.sid)
    .filter((sid) => !WIDE_ACCESS_SIDS.has(sid) && !TRUSTED_ACL_SIDS.has(sid));
  const unique = [...new Set(extra)];
  process.env.ATTACHMENTS_ACL_ALLOWED_SIDS = unique.join(',');
  // 必须可见：否则测试会在"生产会拒绝"的 ACL 配置上静默通过。
  console.warn(
    `[windows-acl-allowlist] 测试进程显式信任的本机 ACL 主体: ${unique.join(',') || '(无)'}`,
  );
}
