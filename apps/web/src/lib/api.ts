/**
 * Typed API client for the web app. All requests go through the same-origin
 * `/api/v1` proxy (see next.config.ts rewrites) so the httpOnly session cookie
 * is sent automatically; mutating requests carry the CSRF defence-in-depth
 * header expected by the API's SessionGuard.
 */

const CSRF_HEADER = 'x-requested-with';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  const method = (init.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    headers.set(CSRF_HEADER, 'XMLHttpRequest');
  }
  if (init.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(`/api/v1${path}`, {
    ...init,
    headers,
    credentials: 'same-origin',
  });

  if (!response.ok) {
    let message = `请求失败（${response.status}）`;
    try {
      const body = (await response.json()) as { message?: string | string[] };
      if (typeof body.message === 'string') {
        message = body.message;
      } else if (Array.isArray(body.message)) {
        message = body.message.join('；');
      }
    } catch {
      // keep the generic message when the body is not JSON
    }
    throw new ApiError(message, response.status);
  }
  return (await response.json()) as T;
}

export const api = {
  login: (body: { accountOrEmail: string; password: string }) =>
    request<{ mfaRequired: boolean; mfaSetupRequired: boolean }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  me: () =>
    request<{
      id: string;
      account: string;
      name: string;
      workEmail: string;
      status: string;
      mfaEnabled: boolean;
    }>('/auth/me'),
  logout: () => request<{ ok: boolean }>('/auth/logout', { method: 'POST' }),
  logoutAll: () => request<{ ok: boolean }>('/auth/logout-all', { method: 'POST' }),
  acceptInvitation: (body: { token: string; name: string; password: string }) =>
    request<{ ok: boolean; account: string }>('/invitations/accept', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  createInvitation: (body: { email: string }) =>
    request<{ ok: boolean; invitationId: string; token: string }>('/invitations', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  mfaSetup: () => request<{ secret: string; otpauthUrl: string }>('/mfa/setup', { method: 'POST' }),
  mfaEnable: (body: { code: string }) =>
    request<{ ok: boolean; recoveryCodes: string[] }>('/mfa/enable', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  mfaDisable: (body: { password: string; code: string }) =>
    request<{ ok: boolean }>('/mfa/disable', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  mfaVerify: (body: { code: string }) =>
    request<{ ok: boolean; account: string }>('/mfa/verify', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  mfaRecoveryLogin: (body: { code: string }) =>
    request<{ ok: boolean; account: string }>('/mfa/recovery-login', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  mfaRecoveryRotate: (body: { password: string; code: string }) =>
    request<{ ok: boolean; recoveryCodes: string[] }>('/mfa/recovery-rotate', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  listSessions: () =>
    request<
      {
        id: string;
        deviceInfo: string | null;
        createdAt: string;
        lastUsedAt: string | null;
        expiresAt: string;
      }[]
    >('/sessions'),
  revokeSession: (id: string) =>
    request<{ ok: boolean }>(`/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};
