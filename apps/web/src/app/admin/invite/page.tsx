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
  const [created, setCreated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<InviteForm>({ resolver: zodResolver(inviteSchema) });

  async function onSubmit(values: InviteForm): Promise<void> {
    setError(null);
    setCreated(false);
    try {
      await api.createInvitation({ email: values.email });
      setCreated(true);
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
        <p className="boundary-note">输入对方的工作邮箱，系统会通过邮件发送一次性激活链接。</p>

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
            {isSubmitting ? '发送中…' : '发送邀请'}
          </button>
        </form>

        {created ? (
          <p className="status-line" role="status">
            邀请已创建，激活邮件已加入发送队列。
          </p>
        ) : null}
      </section>
    </main>
  );
}
