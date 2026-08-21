'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { useState } from 'react';
import { z } from 'zod';

import { api, ApiError } from '@/lib/api';

const loginSchema = z.object({
  accountOrEmail: z.string().min(1, '请输入账号或工作邮箱'),
  password: z.string().min(1, '请输入密码'),
});

type LoginForm = z.infer<typeof loginSchema>;

export default function LoginPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginForm>({ resolver: zodResolver(loginSchema) });

  async function onSubmit(values: LoginForm): Promise<void> {
    setError(null);
    try {
      const result = await api.login(values);
      if (result.mfaSetupRequired) {
        router.push('/mfa-setup');
      } else if (result.mfaRequired) {
        router.push('/mfa');
      } else {
        router.push('/');
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '登录失败，请稍后再试');
    }
  }

  return (
    <main className="auth-shell">
      <section className="status-panel auth-panel-compact" aria-labelledby="login-title">
        <p className="eyebrow">项目运营中心</p>
        <h1 id="login-title">登录</h1>
        <p className="boundary-note">使用管理员分配的账号或工作邮箱登录。</p>

        <form className="form-stack" onSubmit={handleSubmit(onSubmit)} noValidate>
          <label className="field">
            <span className="field-label">账号或工作邮箱</span>
            <input type="text" autoComplete="username" {...register('accountOrEmail')} />
            {errors.accountOrEmail ? (
              <span className="field-error" role="alert">
                {errors.accountOrEmail.message}
              </span>
            ) : null}
          </label>

          <label className="field">
            <span className="field-label">密码</span>
            <input type="password" autoComplete="current-password" {...register('password')} />
            {errors.password ? (
              <span className="field-error" role="alert">
                {errors.password.message}
              </span>
            ) : null}
          </label>

          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}

          <button type="submit" className="btn-primary" disabled={isSubmitting}>
            {isSubmitting ? '登录中…' : '登录'}
          </button>
        </form>
      </section>
    </main>
  );
}
