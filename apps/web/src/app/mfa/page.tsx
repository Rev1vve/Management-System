'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { api, ApiError } from '@/lib/api';

const mfaSchema = z.object({
  code: z.string().regex(/^\d{6}$/, '请输入 6 位验证码'),
});

const recoverySchema = z.object({
  recoveryCode: z.string().min(1, '请输入恢复码'),
});

type MfaForm = z.infer<typeof mfaSchema>;
type RecoveryForm = z.infer<typeof recoverySchema>;

export default function MfaPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'totp' | 'recovery'>('totp');

  const totp = useForm<MfaForm>({ resolver: zodResolver(mfaSchema) });
  const recovery = useForm<RecoveryForm>({
    resolver: zodResolver(recoverySchema),
  });

  async function verifyTotp(values: MfaForm): Promise<void> {
    setError(null);
    try {
      await api.mfaVerify({ code: values.code });
      router.push('/');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '验证失败，请稍后再试');
    }
  }

  async function verifyRecovery(values: RecoveryForm): Promise<void> {
    setError(null);
    try {
      await api.mfaRecoveryLogin({ code: values.recoveryCode });
      router.push('/');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '恢复码无效或已使用');
    }
  }

  return (
    <main className="auth-shell">
      <section className="status-panel" aria-labelledby="mfa-title">
        <p className="eyebrow">项目运营中心</p>
        <h1 id="mfa-title">双重验证</h1>
        <p className="boundary-note">请输入身份验证器中的 6 位动态验证码完成登录。</p>

        {mode === 'totp' ? (
          <form className="form-stack" onSubmit={totp.handleSubmit(verifyTotp)} noValidate>
            <label className="field">
              <span className="field-label">动态验证码</span>
              <input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                {...totp.register('code')}
              />
              {totp.formState.errors.code ? (
                <span className="field-error" role="alert">
                  {totp.formState.errors.code.message}
                </span>
              ) : null}
            </label>

            {error ? (
              <p className="form-error" role="alert">
                {error}
              </p>
            ) : null}

            <button type="submit" className="btn-primary" disabled={totp.formState.isSubmitting}>
              {totp.formState.isSubmitting ? '验证中…' : '验证并登录'}
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                setMode('recovery');
                setError(null);
              }}
            >
              使用恢复码
            </button>
          </form>
        ) : (
          <form className="form-stack" onSubmit={recovery.handleSubmit(verifyRecovery)} noValidate>
            <label className="field">
              <span className="field-label">恢复码</span>
              <input type="text" autoComplete="off" {...recovery.register('recoveryCode')} />
              {recovery.formState.errors.recoveryCode ? (
                <span className="field-error" role="alert">
                  {recovery.formState.errors.recoveryCode.message}
                </span>
              ) : null}
            </label>

            {error ? (
              <p className="form-error" role="alert">
                {error}
              </p>
            ) : null}

            <button
              type="submit"
              className="btn-primary"
              disabled={recovery.formState.isSubmitting}
            >
              {recovery.formState.isSubmitting ? '验证中…' : '使用恢复码登录'}
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                setMode('totp');
                setError(null);
              }}
            >
              返回动态验证码
            </button>
          </form>
        )}
      </section>
    </main>
  );
}
