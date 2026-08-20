'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { QRCodeSVG } from 'qrcode.react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { api, ApiError } from '@/lib/api';

const enableSchema = z.object({
  code: z.string().regex(/^\d{6}$/, '请输入 6 位验证码'),
});

type EnableForm = z.infer<typeof enableSchema>;

export default function MfaSetupPage() {
  const router = useRouter();
  const [enrollment, setEnrollment] = useState<{
    secret: string;
    otpauthUrl: string;
  } | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<EnableForm>({ resolver: zodResolver(enableSchema) });

  async function startEnrollment(): Promise<void> {
    setError(null);
    try {
      const result = await api.mfaSetup();
      setEnrollment({ secret: result.secret, otpauthUrl: result.otpauthUrl });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '获取 MFA 设置失败');
    }
  }

  async function enable(values: EnableForm): Promise<void> {
    setError(null);
    try {
      const result = await api.mfaEnable({ code: values.code });
      setRecoveryCodes(result.recoveryCodes);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '启用失败，请检查验证码');
    }
  }

  if (recoveryCodes) {
    return (
      <main className="auth-shell">
        <section className="status-panel" aria-labelledby="done-title">
          <p className="eyebrow">项目运营中心</p>
          <h1 id="done-title">MFA 已启用</h1>
          <p className="status-line">双重验证已开启</p>
          <p className="boundary-note">
            请立即保存以下恢复码（仅显示这一次）。丢失验证器时用它登录；每个恢复码只能使用一次。
          </p>
          <ul className="recovery-codes">
            {recoveryCodes.map((code) => (
              <li key={code}>{code}</li>
            ))}
          </ul>
          <button type="button" className="btn-primary" onClick={() => router.push('/')}>
            进入系统
          </button>
        </section>
      </main>
    );
  }

  return (
    <main className="auth-shell">
      <section className="status-panel" aria-labelledby="setup-title">
        <p className="eyebrow">项目运营中心</p>
        <h1 id="setup-title">设置双重验证</h1>
        <p className="boundary-note">
          你的角色要求启用 TOTP 双重验证。请用身份验证器 App 扫描二维码。
        </p>

        {!enrollment ? (
          <button
            type="button"
            className="btn-primary"
            onClick={() => void startEnrollment()}
            disabled={isSubmitting}
          >
            开始设置
          </button>
        ) : (
          <>
            <div className="mfa-qr">
              <QRCodeSVG value={enrollment.otpauthUrl} size={200} />
            </div>
            <p className="boundary-note">
              无法扫码？手动输入密钥：<code>{enrollment.secret}</code>
            </p>

            <form className="form-stack" onSubmit={handleSubmit(enable)} noValidate>
              <label className="field">
                <span className="field-label">验证身份验证器中的 6 位验证码</span>
                <input
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  {...register('code')}
                />
                {errors.code ? (
                  <span className="field-error" role="alert">
                    {errors.code.message}
                  </span>
                ) : null}
              </label>

              {error ? (
                <p className="form-error" role="alert">
                  {error}
                </p>
              ) : null}

              <button type="submit" className="btn-primary" disabled={isSubmitting}>
                {isSubmitting ? '启用中…' : '启用双重验证'}
              </button>
            </form>
          </>
        )}
      </section>
    </main>
  );
}
