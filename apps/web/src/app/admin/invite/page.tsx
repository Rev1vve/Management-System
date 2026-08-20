'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { api, ApiError } from '@/lib/api';

const inviteSchema = z.object({
  email: z.string().email('请输入有效的工作邮箱'),
});

type InviteForm = z.infer<typeof inviteSchema>;

export default function AdminInvitePage() {
  const [result, setResult] = useState<{ token: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<InviteForm>({ resolver: zodResolver(inviteSchema) });

  async function onSubmit(values: InviteForm): Promise<void> {
    setError(null);
    setResult(null);
    try {
      const created = await api.createInvitation({ email: values.email });
      // Development: the raw token is returned exactly once. In production the
      // activation link is delivered by the EmailOutbox worker instead.
      setResult({ token: created.token });
      reset();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '邀请失败，请稍后再试');
    }
  }

  return (
    <main className="auth-shell">
      <section className="status-panel" aria-labelledby="invite-title">
        <p className="eyebrow">项目运营中心</p>
        <h1 id="invite-title">邀请用户</h1>
        <p className="boundary-note">
          输入对方的工作邮箱，系统会生成一次性激活链接（开发环境直接返回令牌）。
        </p>

        <form className="form-stack" onSubmit={handleSubmit(onSubmit)} noValidate>
          <label className="field">
            <span className="field-label">工作邮箱</span>
            <input type="email" autoComplete="off" {...register('email')} />
            {errors.email ? (
              <span className="field-error" role="alert">
                {errors.email.message}
              </span>
            ) : null}
          </label>

          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}

          <button type="submit" className="btn-primary" disabled={isSubmitting}>
            {isSubmitting ? '生成中…' : '生成邀请'}
          </button>
        </form>

        {result ? (
          <p className="status-line" role="status">
            邀请已创建。激活令牌（仅此一次）：<code>{result.token}</code>
          </p>
        ) : null}
      </section>
    </main>
  );
}
