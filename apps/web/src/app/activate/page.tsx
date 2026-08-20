'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { api, ApiError } from '@/lib/api';

const activateSchema = z
  .object({
    name: z.string().min(1, '请输入姓名'),
    password: z.string().min(8, '密码至少 8 位'),
    confirmPassword: z.string().min(1, '请再次输入密码'),
  })
  .refine((v) => v.password === v.confirmPassword, {
    message: '两次输入的密码不一致',
    path: ['confirmPassword'],
  });

type ActivateForm = z.infer<typeof activateSchema>;

function ActivateFormInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get('token') ?? '';
  const [error, setError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ActivateForm>({ resolver: zodResolver(activateSchema) });

  async function onSubmit(values: ActivateForm): Promise<void> {
    setError(null);
    try {
      const result = await api.acceptInvitation({
        token,
        name: values.name,
        password: values.password,
      });
      router.push(`/?activated=${encodeURIComponent(result.account)}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '激活失败，请稍后再试');
    }
  }

  if (!token) {
    return <p className="form-error">缺少激活令牌，请使用邮件中的完整链接。</p>;
  }

  return (
    <main className="auth-shell">
      <section className="status-panel" aria-labelledby="activate-title">
        <p className="eyebrow">项目运营中心</p>
        <h1 id="activate-title">激活账号</h1>
        <p className="boundary-note">设置你的姓名与登录密码，完成账号激活。</p>

        <form className="form-stack" onSubmit={handleSubmit(onSubmit)} noValidate>
          <label className="field">
            <span className="field-label">姓名</span>
            <input type="text" autoComplete="name" {...register('name')} />
            {errors.name ? (
              <span className="field-error" role="alert">
                {errors.name.message}
              </span>
            ) : null}
          </label>

          <label className="field">
            <span className="field-label">密码</span>
            <input type="password" autoComplete="new-password" {...register('password')} />
            {errors.password ? (
              <span className="field-error" role="alert">
                {errors.password.message}
              </span>
            ) : null}
          </label>

          <label className="field">
            <span className="field-label">确认密码</span>
            <input type="password" autoComplete="new-password" {...register('confirmPassword')} />
            {errors.confirmPassword ? (
              <span className="field-error" role="alert">
                {errors.confirmPassword.message}
              </span>
            ) : null}
          </label>

          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}

          <button type="submit" className="btn-primary" disabled={isSubmitting}>
            {isSubmitting ? '激活中…' : '激活并登录'}
          </button>
        </form>
      </section>
    </main>
  );
}

export default function ActivatePage() {
  return (
    <Suspense>
      <ActivateFormInner />
    </Suspense>
  );
}
