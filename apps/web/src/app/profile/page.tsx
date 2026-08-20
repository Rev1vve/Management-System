'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { api, ApiError } from '@/lib/api';

export default function ProfilePage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const me = useQuery({
    queryKey: ['me'],
    queryFn: api.me,
    retry: false,
  });

  const sessions = useQuery({
    queryKey: ['sessions'],
    queryFn: api.listSessions,
    retry: false,
  });

  async function run(action: () => Promise<unknown>, okText: string): Promise<void> {
    setError(null);
    setMessage(null);
    try {
      await action();
      setMessage(okText);
      await queryClient.invalidateQueries();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '操作失败，请稍后再试');
    }
  }

  if (me.isLoading) {
    return (
      <main className="auth-shell">
        <p>加载中…</p>
      </main>
    );
  }
  if (me.isError || !me.data) {
    return (
      <main className="auth-shell">
        <section className="status-panel">
          <p className="form-error">未登录或会话已失效。</p>
          <button type="button" className="btn-primary" onClick={() => router.push('/login')}>
            去登录
          </button>
        </section>
      </main>
    );
  }

  const user = me.data;

  return (
    <main className="auth-shell">
      <section className="status-panel" aria-labelledby="profile-title">
        <p className="eyebrow">项目运营中心</p>
        <h1 id="profile-title">个人资料</h1>

        <dl className="profile-dl">
          <div>
            <dt>姓名</dt>
            <dd>{user.name}</dd>
          </div>
          <div>
            <dt>账号</dt>
            <dd>{user.account}</dd>
          </div>
          <div>
            <dt>工作邮箱</dt>
            <dd>{user.workEmail}</dd>
          </div>
          <div>
            <dt>双重验证</dt>
            <dd>{user.mfaEnabled ? '已启用' : '未启用'}</dd>
          </div>
        </dl>

        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        {message ? (
          <p className="status-line" role="status">
            {message}
          </p>
        ) : null}

        <div className="action-row">
          {user.mfaEnabled ? (
            <details className="rotate-box">
              <summary className="btn-secondary">轮换恢复码</summary>
              <form
                className="form-stack"
                onSubmit={(e) => {
                  e.preventDefault();
                  const form = new FormData(e.currentTarget);
                  void run(
                    () =>
                      api.mfaRecoveryRotate({
                        password: String(form.get('password') ?? ''),
                        code: String(form.get('code') ?? ''),
                      }),
                    '已生成新的恢复码（请立即保存，旧码已失效）',
                  );
                }}
              >
                <label className="field">
                  <span className="field-label">当前密码</span>
                  <input type="password" name="password" autoComplete="current-password" required />
                </label>
                <label className="field">
                  <span className="field-label">当前验证码</span>
                  <input
                    type="text"
                    name="code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    required
                  />
                </label>
                <button type="submit" className="btn-primary">
                  轮换
                </button>
              </form>
            </details>
          ) : (
            <button type="button" className="btn-primary" onClick={() => router.push('/mfa-setup')}>
              启用双重验证
            </button>
          )}
          <button
            type="button"
            className="btn-secondary"
            onClick={() => void run(api.logoutAll, '已退出所有设备')}
          >
            退出全部设备
          </button>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => void run(api.logout, '已退出登录')}
          >
            退出登录
          </button>
        </div>

        <h2>活跃会话</h2>
        <div className="session-list">
          {sessions.data?.map((s) => (
            <div className="session-item" key={s.id}>
              <span>{s.deviceInfo ?? '当前设备'}</span>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => void run(() => api.revokeSession(s.id), '会话已撤销')}
              >
                撤销
              </button>
            </div>
          ))}
          {sessions.data?.length === 0 ? <p className="boundary-note">暂无活跃会话。</p> : null}
        </div>
      </section>
    </main>
  );
}
