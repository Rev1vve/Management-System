import { describe, expect, it } from 'vitest';

import { type AclEntry, evaluateAcl, parseAclOutput, WIDE_ACCESS_SIDS } from './storage-platform';

/**
 * Windows ACL 白名单判定的纯函数测试（不触真实文件系统）。
 *
 * 这些用例是审查（review-1）后补的：原实现是 6 个 SID + 7 个英文名"黑名单"，
 * 任何未知安全组都会静默通过。这里固定"默认拒绝"的语义。
 */
const RUNTIME = 'S-1-5-21-1000-2000-3000-1001';
const SYSTEM = 'S-1-5-18';
const ADMINS = 'S-1-5-32-544';
const FOREIGN = 'S-1-5-21-9000-8000-7000-6666';

function allow(sid: string, rights = 'FullControl'): AclEntry {
  return { sid, type: 'allow', rights };
}
function deny(sid: string, rights = 'FullControl'): AclEntry {
  return { sid, type: 'deny', rights };
}

describe('parseAclOutput', () => {
  it('parses structured SID rows and ignores noise', () => {
    const output = [
      `${RUNTIME}|Allow|FullControl`,
      `${SYSTEM}|Allow|FullControl`,
      '已被成功处理的文件数: 1',
      '',
      'not-a-row',
      `${FOREIGN}|Deny|Read`,
    ].join('\r\n');

    expect(parseAclOutput(output)).toEqual([
      { sid: RUNTIME, type: 'allow', rights: 'FullControl' },
      { sid: SYSTEM, type: 'allow', rights: 'FullControl' },
      { sid: FOREIGN, type: 'deny', rights: 'Read' },
    ]);
  });

  it('returns no entries for unparsable output so callers fail closed', () => {
    expect(parseAclOutput('乱码 \u0000 garbage')).toEqual([]);
  });
});

describe('evaluateAcl', () => {
  it('accepts runtime + SYSTEM + Administrators only', () => {
    expect(
      evaluateAcl([allow(RUNTIME), allow(SYSTEM), allow(ADMINS, 'Modify, Synchronize')], RUNTIME),
    ).toEqual({ ok: true });
  });

  it('rejects an unknown principal holding Modify (previous blacklist hole)', () => {
    const verdict = evaluateAcl([allow(RUNTIME), allow(FOREIGN, 'Modify, Synchronize')], RUNTIME);
    expect(verdict.ok).toBe(false);
  });

  it.each([...WIDE_ACCESS_SIDS])('rejects wide principal %s even when allow-listed', (sid) => {
    const verdict = evaluateAcl([allow(RUNTIME), allow(sid)], RUNTIME, [sid]);
    expect(verdict.ok).toBe(false);
  });

  it('ignores Deny entries (they only tighten access)', () => {
    expect(evaluateAcl([allow(RUNTIME), deny(FOREIGN)], RUNTIME)).toEqual({ ok: true });
  });

  it('requires the runtime identity to hold FullControl or Modify', () => {
    const verdict = evaluateAcl([allow(RUNTIME, 'Read, Synchronize'), allow(SYSTEM)], RUNTIME);
    expect(verdict.ok).toBe(false);
  });

  it('fails closed when there is no Allow entry at all', () => {
    expect(evaluateAcl([], RUNTIME).ok).toBe(false);
    expect(evaluateAcl([deny(RUNTIME)], RUNTIME).ok).toBe(false);
  });

  it('honours an explicit operator allowlist for restricted-token environments', () => {
    expect(evaluateAcl([allow(RUNTIME), allow(FOREIGN, 'Modify')], RUNTIME, [FOREIGN])).toEqual({
      ok: true,
    });
  });

  it('is case-insensitive about SID casing', () => {
    expect(
      evaluateAcl([{ sid: RUNTIME.toLowerCase(), type: 'allow', rights: 'FullControl' }], RUNTIME),
    ).toEqual({ ok: true });
  });
});
